/**
 * dsh-github-hot —— 宿主半侧（host half）
 *
 * 职责：把 Hysen Labs（hysenlabs.com）的公开榜单数据取回来、解析成结构化 JSON、
 * 按周期缓存，通过 /dsh-github-hot/ 前缀的只读接口交给浏览器半侧去画。
 * 浏览器半侧**只负责渲染**，不做任何取数与解析。
 *
 * ============================ 数据源（全部免 key、公开可访问）============================
 *
 *   日榜   GET https://hysenlabs.com/data/star-growth-24h.csv        500 项，CSV
 *   月榜   GET https://hysenlabs.com/data/star-growth-30d.csv        500 项，CSV
 *   周榜   GET https://hysenlabs.com/weekly/{YYYY-MM-DD}             TOP10，HTML
 *   曲线   GET https://hysenlabs.com/chart/{slug}.svg                星数历史折线（SVG 路径）
 *   简介   GET https://hysenlabs.com/projects/{slug}                 编辑分析（HTML，取首个结论段）
 *
 * CSV 的字段（两份一致，只有「名次变化」那一列不同名）：
 *   rank, repository, github_url, hysenlabs_url, stars_gained, start_stars,
 *   end_stars, growth_pct, rank_change_vs_day_ago | rank_change_vs_week_ago,
 *   language, license, window_start, window_end
 *
 * ============================ 三个必须守住的口径 ============================
 *
 * 1) **缺口如实标注，绝不编数**：CSV / HTML / SVG 任一取不到，那一段就标 stale 并给出
 *    原因与上次成功时间；界面照实显示「这次没拿到」，而不是悄悄退回旧数据当新的。
 *
 * 2) **简介不编**：项目分析页取不到时，desc 字段留空、descSource 标 'none'，
 *    界面显示「暂无简介」；绝不拿模型生成一段冒充 Hysen 的编辑分析。
 *
 * 3) **解析容错**：周榜是页面 HTML（对方改版即失效）、曲线是 SVG 路径（坐标口径可能变）。
 *    两处都做「解析不到就整段标失败」，不做模糊兜底 —— 模糊兜底会产出看似正常的错数据。
 *
 * ============================ 缓存与限流 ============================
 * 榜单缓存 10 分钟（Hysen 数据每天才动一次，没必要勤刷）；单项目详情（简介 + 曲线）
 * 缓存 6 小时。所有请求串行排队，同一 URL 在途去重，避免并发打爆对方站点。
 *
 * 依赖策略：静态 import 只有 node 内置模块 + 全局 fetch，不 import 任何 @deepseek-ai/*，
 * 这样官方包改名换布局都不会导致本插件整体加载失败。
 */

import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

/** 插件名：必须与包名、cordis.patch.yml 的 id 一致。 */
export const name = 'dsh-github-hot';

/** 硬依赖：只要 webServer（提供路由）。 */
export const inject = ['webServer'];

/**
 * 版本号：从 package.json 读，**不要在这里写死**。
 *
 * 写死的话每次发版都要记得改两处，漏改就会让 /status 报旧版本
 * （用户排查问题时会被误导）。这里用 createRequire 读同包的 manifest。
 */
const VERSION = (() => {
  try {
    const require = createRequire(import.meta.url);
    return require('../package.json').version || '0.0.0';
  } catch {
    return '0.0.0';
  }
})();
const ROUTE_PREFIX = '/dsh-github-hot';

const BASE = 'https://hysenlabs.com';
const UA = 'dsh-github-hot/' + VERSION + ' (+https://github.com/)';

/**
 * 缓存时长 —— 按**数据源的真实更新节奏**定，而不是按「刷新得勤快一点」定。
 *
 * 上游数据**每天只更新一次**（其方法页写明 "A daily job captures public repository
 * Star counts"），日榜窗口为「前一天 → 当天」，月榜为「30 天前 → 当天」。所以：
 *
 *   · 榜单：同一自然日内结果不会变 → 按天缓存，跨天自动失效。
 *   · 项目详情（简介 + 曲线）：曲线也是每日快照 → 同样按天缓存。
 *   · 翻译结果：按原文哈希缓存，永不过期（原文不变就不重翻）。
 *
 * 这样「反复打开面板」不会再打到对方站点，也不会有拉不到新数据的错觉。
 */
const DAY_MS = 24 * 60 * 60 * 1000;
/** 榜单缓存：跨自然日才失效（不是 24 小时，是「今天 vs 昨天」）。 */
const BOARD_TTL_MS = DAY_MS;
/** 单项目详情（简介 + 曲线）：同样按天。 */
const DETAIL_TTL_MS = DAY_MS;

/** 「本地日期」串（YYYY-MM-DD），用于判断缓存是否跨天。 */
/**
 * 数据源时区。
 *
 * ★ 这是全插件**唯一**的时区基准，别处不要再自己算日期。
 *
 * 为什么必须是 Asia/Shanghai：Hysen Labs 的周榜口径明确写着
 * 「完整的周一到周日，时区 Asia/Shanghai」，日榜/月榜的窗口也是按这个时区切的。
 * 如果按用户本地时区算「今天是哪天」，那么：
 *   · 北京时间周一 08:00（美西还是周日）的用户会算出「上周一」，拿到的是旧周榜；
 *   · 跨时区用户看到的「数据更新到 X 月 X 日」会互相不一致。
 * 数据是哪天的，应该由**数据源**说了算，不是由看的人所在时区说了算。
 */
const SOURCE_TZ = 'Asia/Shanghai';

/** 把某个时刻格式化成数据源时区下的 YYYY-MM-DD。 */
function dayKeyInSourceTz(ts) {
  const d = new Date(ts === undefined || ts === null ? Date.now() : ts);
  // Intl 直接给出目标时区的年月日，不受运行机器时区影响
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: SOURCE_TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(d);
  const get = (t) => (parts.find((x) => x.type === t) || {}).value;
  return get('year') + '-' + get('month') + '-' + get('day');
}

/** 兼容旧名字：缓存有效期判断用的就是「数据源时区的今天」。 */
function localDayKey(ts) {
  return dayKeyInSourceTz(ts);
}
/** 版本检查缓存：一天查一次足够（npm 上不会一天发几十个版本）。 */
const UPDATE_CACHE_KEY = 'update:npm';
const UPDATE_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * 比较两个 semver 版本号（忽略预发布后缀）。
 * 返回 1：a 更新；0：相同；-1：b 更新。
 */
function compareVersion(a, b) {
  const norm = (v) => String(v || '').split('-')[0].split('.').map((x) => Number(x) || 0);
  const pa = norm(a);
  const pb = norm(b);
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const x = pa[i] || 0;
    const y = pb[i] || 0;
    if (x > y) return 1;
    if (x < y) return -1;
  }
  return 0;
}

/** 翻译并发：模型调用是 IO 等待，8 条同时翻比 4 条快一倍。 */
const TRANSLATE_CONCURRENCY = 8;
/** 取数并发：抓对方站点，礼貌一点。 */
const FETCH_CONCURRENCY = 4;

/** 单次请求超时。 */
const REQUEST_TIMEOUT_MS = 20000;
/** 简介最多保留多少字（页面提取的第一段结论通常几百字）。 */
const DESC_MAX_CHARS = 260;

/* ------------------------------------------------------------------ 工具 */

function nowIso() {
  return new Date().toISOString();
}

function safeInt(value) {
  const n = Number(String(value ?? '').replace(/[, ]/g, ''));
  return Number.isFinite(n) ? Math.round(n) : null;
}

function safeFloat(value) {
  const n = Number(String(value ?? '').replace(/[,% ]/g, ''));
  return Number.isFinite(n) ? n : null;
}

function text(value) {
  return String(value ?? '').trim();
}

/** 把 "owner/repo" 归一成 Hysen 的 slug：小写 + 斜杠换横线。 */
/**
 * "owner/repo" → Hysen 的 slug（小写 + 斜杠换横线）。
 *
 * 安全要点：结果要同时用作 **URL 路径** 和 **本地缓存文件名**，所以必须彻底净化：
 *   · 只留 [a-z0-9-]；
 *   · 点号一律去掉 —— 否则 `..` 会作为文件名的一部分被保留，形成目录穿越隐患；
 *   · 连续横线压成一个，首尾横线去掉，避免生成 `-etc-hosts` 这种怪名。
 */
function slugOf(repository) {
  return text(repository)
    .toLowerCase()
    .replace(/\//g, '-')          // owner/repo 的分隔
    .replace(/[^a-z0-9-]/g, '')    // 只留字母数字和横线（点号也去掉）
    .replace(/-{2,}/g, '-')        // 压缩连续横线
    .replace(/^-+|-+$/g, '');      // 去掉首尾横线
}

function cleanHtml(input) {
  return String(input)
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

/** 一个带 TTL 的极简缓存。 */
const cache = new Map();

/* ------------------------------------------------------------ 磁盘缓存 */

/**
 * 内存缓存 + 磁盘缓存。
 *
 * 为什么要落盘：面板关闭、DSH 重启之后，内存缓存全丢 ⇒ 再打开就要全量重取一遍，
 * 既慢又白打对方站点。数据源每天才更新一次，所以缓存完全可以跨进程复用。
 *
 * 落盘策略：
 *   · 路径：$DSH_HOME/dsh-github-hot/cache.json（没有 DSH_HOME 就退回 ~/.dsh）
 *   · 时机：写入后**节流落盘**（最多每 3 秒一次），避免每张卡片都触发一次磁盘写
 *   · 容量：最多保留 800 条，超出按写入时间淘汰最旧的
 *   · 容错：文件损坏 / 无权限一律当作空缓存，**绝不让缓存问题拖垮插件**
 */

const CACHE_FILE_NAME = 'cache.json';
/**
 * 缓存结构版本。改了缓存里存的结构（例如给曲线点加了 date 字段）就 +1，
 * 旧文件会被整体丢弃 —— 否则会用「结构已过期」的数据静默喂给界面。
 *
 * v3：曲线日期改为 UTC 口径统一计算 + 时区统一到数据源（Asia/Shanghai）。
 */
const CACHE_STRUCTURE_VERSION = 3;
const CACHE_MAX_ENTRIES = 800;
const FLUSH_DELAY_MS = 3000;

let cacheLoaded = false;
let flushTimer = null;

function cacheFilePath() {
  const home = process.env.DSH_HOME || join(homedir(), '.dsh');
  return join(home, 'dsh-github-hot', CACHE_FILE_NAME);
}

/** 启动时把磁盘缓存读进内存（只做一次）。 */
function ensureCacheLoaded() {
  if (cacheLoaded) return;
  cacheLoaded = true;
  try {
    const file = cacheFilePath();
    if (!existsSync(file)) return;
    const raw = readFileSync(file, 'utf8');
    const data = JSON.parse(raw);
    if (!data || typeof data !== 'object' || !data.entries) return;
    if (data.version !== CACHE_STRUCTURE_VERSION) return; // 结构变了，整份作废
    const now = Date.now();
    for (const [key, entry] of Object.entries(data.entries)) {
      if (!entry || typeof entry.at !== 'number') continue;
      // 只恢复「不是太旧」的条目：按天缓存的跨天就丢，避免恢复一堆废数据
      if (now - entry.at > DAY_MS) continue;
      cache.set(key, { at: entry.at, value: entry.value });
    }
  } catch {
    /* 缓存读不出来就当空缓存，不影响功能 */
  }
}

/** 节流落盘。 */
function scheduleFlush() {
  if (flushTimer !== null) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    flushCache();
  }, FLUSH_DELAY_MS);
  if (typeof flushTimer.unref === 'function') flushTimer.unref();
}

function flushCache() {
  try {
    const file = cacheFilePath();
    const dir = join(file, '..');
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    // 超出上限就按时间保留最新的那批
    let entries = [...cache.entries()];
    if (entries.length > CACHE_MAX_ENTRIES) {
      entries.sort((a, b) => b[1].at - a[1].at);
      entries = entries.slice(0, CACHE_MAX_ENTRIES);
    }
    const payload = {
      version: CACHE_STRUCTURE_VERSION,
      savedAt: new Date().toISOString(),
      entries: Object.fromEntries(entries.map(([k, v]) => [k, { at: v.at, value: v.value }])),
    };
    writeFileSync(file, JSON.stringify(payload), 'utf8');
  } catch {
    /* 写不进去就只留内存缓存 */
  }
}

function cacheGet(key, ttlMs) {
  ensureCacheLoaded();
  const hit = cache.get(key);
  if (!hit) return null;
  // 按天缓存：只要还是同一个自然日，就算命中（哪怕已经过去 23 小时）
  if (ttlMs >= DAY_MS) {
    if (localDayKey(hit.at) !== localDayKey(Date.now())) return null;
    return hit.value;
  }
  if (Date.now() - hit.at > ttlMs) return null;
  return hit.value;
}

function cacheSet(key, value) {
  ensureCacheLoaded();
  cache.set(key, { at: Date.now(), value });
  scheduleFlush();
  // 防止无限增长：超过 400 条就清最早的一半
  if (cache.size > 400) {
    const keys = [...cache.keys()].slice(0, 200);
    for (const k of keys) cache.delete(k);
  }
}

/* -------------------------------------------------------------- 出网取数 */

/** 在途去重：同一 URL 同时只发一次。 */
const inflight = new Map();

/**
 * 出网请求调度。
 *
 * 之前用的是**单条全局串行队列** —— 结果一个批次要取 20 个项目时，
 * 后面进来的请求（哪怕只是刷新榜单）也得排队等前面 20 个跑完，
 * 一个批次取 20 个项目时，后进来的请求会被全部阻塞。
 *
 * 现在改成**按 host 分队列 + 限并发**：
 *   · 每个 host 独立一条队列，互不阻塞（hysenlabs 与 GitHub 头像不互相等）；
 *   · 同一 host 最多 CONCURRENCY 个在途，既是礼貌，也避免被对方限流。
 */
const HOST_CONCURRENCY = 4;

/** 每个 host 的在途计数与等待队列。 */
const hostState = new Map();
let lastError = null;

function hostOf(url) {
  try {
    return new URL(url).host;
  } catch {
    return 'unknown';
  }
}

/**
 * 在指定 host 的并发槽里执行 task。
 * 超过并发上限时排队，有空位立刻放行。
 */
function runOnHost(host, task) {
  let state = hostState.get(host);
  if (!state) {
    state = { active: 0, waiting: [] };
    hostState.set(host, state);
  }
  return new Promise((resolve, reject) => {
    const start = () => {
      state.active += 1;
      Promise.resolve()
        .then(task)
        .then(resolve, reject)
        .finally(() => {
          state.active -= 1;
          const next = state.waiting.shift();
          if (next) next();
        });
    };
    if (state.active < HOST_CONCURRENCY) start();
    else state.waiting.push(start);
  });
}

/**
 * GET 一个 URL 并返回文本。
 * 失败抛错（带状态码 / 超时 / 网络原因），**不做重试**：上层按需决定是否保旧。
 */
async function fetchText(url, { accept } = {}) {
  const existing = inflight.get(url);
  if (existing) return existing;
  const task = runOnHost(hostOf(url), async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await fetch(url, {
        method: 'GET',
        headers: {
          'User-Agent': UA,
          Accept: accept || 'text/html,text/csv,application/xml,text/xml,*/*',
        },
        signal: controller.signal,
        redirect: 'follow',
      });
      if (!response.ok) {
        const error = new Error('HTTP ' + response.status + ' ' + response.statusText);
        error.status = response.status;
        throw error;
      }
      return await response.text();
    } catch (error) {
      if (error && error.name === 'AbortError') {
        const timeout = new Error('请求超时（' + REQUEST_TIMEOUT_MS / 1000 + 's）');
        timeout.timeout = true;
        throw timeout;
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  });
  inflight.set(url, task);
  try {
    return await task;
  } finally {
    inflight.delete(url);
  }
}

/* --------------------------------------------------------------- CSV 解析 */

/** 极简 CSV 解析（Hysen 的 CSV 没有引号包裹字段，但仍按引号规则处理一遍）。 */
function parseCsv(raw) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < raw.length; i += 1) {
    const ch = raw[i];
    if (quoted) {
      if (ch === '"') {
        if (raw[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          quoted = false;
        }
      } else {
        field += ch;
      }
      continue;
    }
    if (ch === '"') {
      quoted = true;
    } else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else if (ch !== '\r') {
      field += ch;
    }
  }
  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.length > 1 || text(r[0]) !== '');
}

/** CSV 行 → 结构化榜单项。 */
function boardRow(item, rankFallback) {
  const repository = text(item.repository);
  return {
    rank: safeInt(item.rank) ?? rankFallback,
    repository,
    slug: slugOf(repository),
    githubUrl: text(item.github_url),
    hysenUrl: text(item.hysenlabs_url),
    starsGained: safeInt(item.stars_gained) ?? 0,
    startStars: safeInt(item.start_stars),
    endStars: safeInt(item.end_stars),
    growthPct: safeFloat(item.growth_pct),
    // 两份 CSV 的「名次变化」列名不同，统一成 rankChange
    rankChange:
      item.rank_change_vs_day_ago !== undefined
        ? safeInt(item.rank_change_vs_day_ago)
        : safeInt(item.rank_change_vs_week_ago),
    language: text(item.language),
    license: text(item.license),
  };
}

/* ------------------------------------------------------------ 周榜 HTML 解析 */

/**
 * 解析周榜页。
 *
 * 依赖的页面特征：
 *   <li ... data-testid="ranking-row-3"> ... <a class="...__repo" href="/projects/slug"><span>owner</span> / <!-- -->repo</a>
 *     ... <strong class="...__weekly" data-testid="weekly-stars-3">13,165</strong>
 *     ... <span class="...__total">47,747</span> <span class="...__steady">—</span>
 *     ... <span class="...__language">TypeScript</span>
 *
 * 只要行数、涨星数、仓库名三者对不齐，就整段判失败（返回 null），不做模糊补齐。
 */
function parseWeeklyHtml(html) {
  // 逐行切：以 ranking-row-N 为界
  const rowStarts = [];
  const rowRe = /data-testid="ranking-row-(\d+)"/g;
  let match = rowRe.exec(html);
  while (match) {
    rowStarts.push({ rank: Number(match[1]), index: match.index });
    match = rowRe.exec(html);
  }
  if (rowStarts.length === 0) return null;

  const rows = [];
  for (let i = 0; i < rowStarts.length; i += 1) {
    const start = rowStarts[i].index;
    const end = i + 1 < rowStarts.length ? rowStarts[i + 1].index : Math.min(html.length, start + 4000);
    const chunk = html.slice(start, end);

    const repoMatch = chunk.match(/__repo"\s+href="([^"]*)"[\s\S]*?<span>([^<]*)<\/span>\s*\/\s*(?:<!--\s*-->)?([^<]*)<\/a>/);
    const gainMatch = chunk.match(/__weekly"[^>]*data-testid="weekly-stars-\d+"[^>]*>([\d,]+)</);
    if (!repoMatch || !gainMatch) continue;

    const owner = text(repoMatch[2]);
    const repo = text(repoMatch[3]);
    const href = text(repoMatch[1]);
    const slug = href.startsWith('/projects/') ? href.slice('/projects/'.length) : slugOf(owner + '/' + repo);

    const totalMatch = chunk.match(/__total">([\d,]+)</);
    const langMatch = chunk.match(/__language">([^<]+)</);
    const steadyMatch = chunk.match(/__steady[^"]*">([^<]+)</);

    rows.push({
      rank: rowStarts[i].rank,
      repository: owner + '/' + repo,
      slug,
      githubUrl: 'https://github.com/' + owner + '/' + repo,
      hysenUrl: BASE + '/projects/' + slug,
      starsGained: safeInt(gainMatch[1]) ?? 0,
      startStars: null,
      endStars: totalMatch ? safeInt(totalMatch[1]) : null,
      growthPct: null,
      rankChange: steadyMatch && text(steadyMatch[1]) !== '—' ? safeInt(steadyMatch[1]) : null,
      language: langMatch ? text(langMatch[1]) : '',
      license: '',
    });
  }
  if (rows.length === 0) return null;
  return rows.sort((a, b) => a.rank - b.rank);
}

/** 从周榜页取统计周期文字（例如 "October 26, 2026 — November 1, 2026"）。 */
function parseWeeklyWindow(html) {
  const m = html.match(/([A-Z][a-z]+ \d{1,2}, \d{4})\s*—\s*([A-Z][a-z]+ \d{1,2}, \d{4})/);
  return m ? { start: m[1], end: m[2] } : null;
}

/** 当前这一周（周一）的日期串，用于拼周榜 URL。 */
/**
 * 数据源时区下的「本周一」（周榜 URL 用的就是它）。
 *
 * 必须按 Asia/Shanghai 算：周榜是「周一→周日」切窗口的，
 * 若按用户本地时区算，跨时区用户会请求到错误的周。
 */
function currentWeekMonday() {
  const todayKey = dayKeyInSourceTz(); // YYYY-MM-DD，数据源时区
  // 用 UTC 解析这个「日期串」再算星期，避免再次引入本地时区
  const [y, m, d] = todayKey.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  const dow = dt.getUTCDay(); // 0=周日
  const diff = dow === 0 ? -6 : 1 - dow;
  dt.setUTCDate(dt.getUTCDate() + diff);
  return dt.toISOString().slice(0, 10);
}

/** 解析某一周页面里标注的期号（用页面里的 "week of YYYY-MM-DD" 或直接传入的 Monday）。 */
async function fetchWeekly() {
  const candidates = [];
  const monday = currentWeekMonday();
  candidates.push(monday);
  // 往前推两周，避免「这周一还没发榜」时直接空手
  for (let k = 1; k <= 2; k += 1) {
    // 用 UTC 做日期减法：monday 本身就是「数据源时区的日期串」，
    // 再用本地 Date 去减会被机器时区带偏一天。
    const [y, m, dd] = monday.split('-').map(Number);
    const d = new Date(Date.UTC(y, m - 1, dd));
    d.setUTCDate(d.getUTCDate() - 7 * k);
    candidates.push(d.toISOString().slice(0, 10));
  }

  let lastError = null;
  for (const week of candidates) {
    const url = BASE + '/weekly/' + week;
    try {
      const html = await fetchText(url);
      const rows = parseWeeklyHtml(html);
      if (rows && rows.length > 0) {
        return { week, rows, window: parseWeeklyWindow(html), url };
      }
      lastError = new Error('周榜页解析失败（页面上找不到榜单行）');
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError || new Error('周榜取数失败');
}

/* --------------------------------------------------------- 单项目详情解析 */

/** 从项目分析页里取「编辑结论」那一段（Hysen 的每篇分析都有这一节）。 */
function parseConclusion(html) {
  // 分析页结构：<h3>Editorial conclusion</h3><p>...</p>
  const m = html.match(/<h3[^>]*>\s*Editorial conclusion\s*<\/h3>\s*<p[^>]*>([\s\S]*?)<\/p>/i);
  if (m) {
    const body = m[1];
    // 段内可能分多个 <p>？这里只取第一个 <p> 的正文，保留其全部文字
    const cleaned = cleanHtml(body);
    if (cleaned) return cleaned;
  }
  return null;
}

/** 从项目分析页里取「这是什么」（At a glance → What is it?）。 */
/**
 * 从项目页里抠出仓库所有者头像的 **CDN 直链**。
 *
 * 为什么不走 `github.com/{owner}.png`：那条路要靠 github.com 302 重定向到 CDN，
 * 而 github.com 在国内网络环境下常不可达 —— 但 `avatars.githubusercontent.com`
 * 本身可直连。所以直接从项目页里读取现成的 CDN 地址。
 */
function parseAvatarUrl(html) {
  const m = html.match(/avatars\.githubusercontent\.com\/u\/(\d+)(?:\?[^"'\s]*)?/);
  return m ? 'https://avatars.githubusercontent.com/u/' + m[1] + '?s=96&v=4' : null;
}

function parseWhatIsIt(html) {
  const m = html.match(/What is it\?[\s\S]{0,80}?<\/dt>[\s\S]*?<dd[^>]*>([\s\S]*?)<\/dd>/i)
    || html.match(/<h3[^>]*>\s*What is it\?\s*<\/h3>[\s\S]*?<p[^>]*>([\s\S]*?)<\/p>/i);
  if (m) {
    const cleaned = cleanHtml(m[1]);
    if (cleaned) return cleaned;
  }
  return null;
}

/**
 * 解析星数历史 SVG，还原成数据点。
 *
 * SVG 里：
 *   <path d="M60 325.8 L73.8 325.8 L87.5 325.8 ..." />
 *   y 轴刻度线：每个 <line y1=... /> 配一个数值 <text>（0 / 200k / 400k / 600k）
 *   x 轴：Sep 12 / Sep 25 / ... / Nov 3
 *
 * 返回 [{ index, stars }]（按 x 位置排序）与坐标轴信息；解析不出返回 null。
 */
function parseChartSvg(svg) {
  const pathMatch = svg.match(/<path\s+d="([^"]+)"/);
  if (!pathMatch) return null;
  const d = pathMatch[1];
  const points = [];
  const re = /([ML])\s*([-\d.]+)\s+([-\d.]+)/g;
  let m = re.exec(d);
  while (m) {
    points.push({ cmd: m[1], x: Number(m[2]), y: Number(m[3]) });
    m = re.exec(d);
  }
  if (points.length < 3) return null;

  // y 轴刻度：<line x1="60" x2="776" y1="326" y2="326" ...> 后面紧跟 <text x="52" y="330">0</text>
  const ticks = [];
  const tickRe = /<line[^>]*y1="([\d.]+)"[^>]*\/>\s*<text[^>]*y="([\d.]+)"[^>]*>([^<]+)<\/text>/g;
  let tm = tickRe.exec(svg);
  while (tm) {
    const label = text(tm[3]);
    const value = /k$/i.test(label) ? Number(label.replace(/k$/i, '')) * 1000 : safeInt(label);
    if (value !== null && Number.isFinite(value)) {
      ticks.push({ y: Number(tm[1]), value });
    }
    tm = tickRe.exec(svg);
  }

  // x 轴日期标签
  const dates = [];
  const dateRe = /<text[^>]*x="([\d.]+)"[^>]*y="348"[^>]*>([A-Z][a-z]{2} \d{1,2})<\/text>/g;
  let dm = dateRe.exec(svg);
  while (dm) {
    dates.push({ x: Number(dm[1]), label: text(dm[2]) });
    dm = dateRe.exec(svg);
  }

  if (ticks.length < 2) return null;

  // 用刻度做线性回归：value = a*y + b（刻度可能不是严格线性，但 SVG 是线性的）
  ticks.sort((a, b) => a.y - b.y);
  const y1 = ticks[0].y;
  const v1 = ticks[0].value;
  const y2 = ticks[ticks.length - 1].y;
  const v2 = ticks[ticks.length - 1].value;
  if (y2 === y1) return null;
  const a = (v2 - v1) / (y2 - y1);

  const series = points
    .map((p, index) => ({ x: p.x, y: p.y, stars: v1 + (p.y - y1) * a, index }))
    .sort((p, q) => p.x - q.x);

  /**
   * 把 x 像素还原成**真实日期**（YYYY-MM-DD）。
   *
   * 为什么必须还原：不同项目的曲线跨度差别很大（有的从 7 月开始、有的从 9 月开始），
   * 但终点都是同一个快照日。多曲线对比时只有按真实日期对齐才有可比性，
   * 按「第几个点」硬叠会把不同时间段的走势错位拼在一起。
   *
   * 做法：拿 x 轴首尾两个日期刻度做线性插值。刻度解析不出来就跳过日期，只留像素。
   */
  const sortedDates = dates.sort((p, q) => p.x - q.x);
  let dated = false;
  if (sortedDates.length >= 2) {
    const first = sortedDates[0];
    const last = sortedDates[sortedDates.length - 1];
    const d0 = parseAxisDate(first.label);
    const d1 = parseAxisDate(last.label);
    if (d0 !== null && d1 !== null && last.x !== first.x) {
      const msPerPx = (d1 - d0) / (last.x - first.x);
      /**
       * 日期还原：**用 UTC 构造、用 UTC 取日期串**。
       *
       * 之前写的是 new Date(ts).toISOString().slice(0,10) —— 本身没问题，
       * 但 ts 是「UTC 当天 00:00」再按像素插值算出来的，插值后可能落到
       * 前一天的 23:xx 或当天的 01:xx；只要机器时区不是 UTC，本地读法就会差一天。
       * 这里统一用 UTC 口径取 YYYY-MM-DD，结果与运行机器的时区无关。
       */
      const seen = new Set();
      for (const p of series) {
        const ts = Math.round(d0 + (p.x - first.x) * msPerPx);
        // 先取到「天」，再把时间钉回当天 00:00 UTC —— 避免插值把相邻点挤到同一天
        const utcDay = Date.UTC(
          new Date(ts).getUTCFullYear(),
          new Date(ts).getUTCMonth(),
          new Date(ts).getUTCDate(),
        );
        p.date = new Date(utcDay).toISOString().slice(0, 10);
        /**
         * 说明：同一个日期可能对应多个数据点。
         * 这不是解析错误 —— SVG 画布里一天只有约 14px，相邻两点很可能落在
         * 同一个「天」里。保留原始 x 像素值（前端的曲线就是按 x 比例画的），
         * 日期只用来对齐时间轴和显示，不用于去重。
         */
        if (seen.has(p.date)) p.dupDate = true;
        else seen.add(p.date);
      }
      dated = true;
    }
  }

  const titleMatch = svg.match(/<title>([^<]+)<\/title>/);
  return {
    title: titleMatch ? text(titleMatch[1]) : '',
    series,
    xLabels: sortedDates,
    yTicks: ticks,
    /** 首尾日期（有的话），方便前端直接按日期对齐 */
    range: dated ? { start: series[0].date, end: series[series.length - 1].date } : null,
  };
}

/** 解析 x 轴上的 "Sep 12" 这种标签成时间戳（年份默认今年）。 */
function parseAxisDate(label) {
  const m = String(label || '').match(/^([A-Z][a-z]{2}) (\d{1,2})$/);
  if (!m) return null;
  const months = { Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11 };
  const month = months[m[1]];
  if (month === undefined) return null;
  const day = Number(m[2]);
  // 基准年同样取**数据源时区**的今年，避免跨年边界上差一年
  const yearNow = Number(dayKeyInSourceTz().slice(0, 4));
  const ts = Date.UTC(yearNow, month, day);
  // 若推出来比「现在」还晚很多，说明那是去年的日期（跨年）
  const nowMs = Date.now();
  return ts > nowMs + 7 * 24 * 3600 * 1000 ? Date.UTC(yearNow - 1, month, day) : ts;
}

/* ------------------------------------------------------------ 预翻译 */

/**
 * 后台预翻译：取完榜单后，顺手把前 N 个项目的简介翻成中文。
 *
 * 为什么：用户切到「中文」时才翻译的话，首次要等 20 条模型调用 —— 体感就是
 * 「点了中文，半天才出来」。预翻译在用户还没切过去的时候就把活干了，
 * 等他要中文时，绝大多数已经有译文（命中缓存，秒出）。
 *
 * 三条约束：
 *   · **低优先级**：串行、限并发 4，不抢用户当前请求的带宽；
 *   · **失败静默**：翻译失败只是没预存，用户切过去时还会再试，不报错；
 *   · **只翻前 24 个**：榜单展示上限就是 20，多翻没用。
 */
const PREWARM_LIMIT = 24;
let prewarmRunning = false;

async function prewarmTranslation(ctx, rows) {
  if (prewarmRunning || !ctx) return;
  const targets = (rows || []).slice(0, PREWARM_LIMIT).filter((r) => r && r.desc);
  if (targets.length === 0) return;
  prewarmRunning = true;
  try {
    let cursor = 0;
    const worker = async () => {
      for (;;) {
        const i = cursor++;
        if (i >= targets.length) return;
        try {
          await translateDesc(ctx, targets[i].desc);
        } catch {
          /* 单条失败忽略 */
        }
      }
    };
    // 并发 4：比用户请求低，避免抢带宽
    await Promise.all(Array.from({ length: Math.min(4, targets.length) }, worker));
  } finally {
    prewarmRunning = false;
  }
}

/* ---------------------------------------------------------------- 取数编排 */

/** 拉一份 CSV 榜单。 */
async function fetchCsvBoard(path) {
  const url = BASE + path;
  const raw = await fetchText(url, { accept: 'text/csv,text/plain,*/*' });
  const table = parseCsv(raw);
  if (table.length < 2) throw new Error('CSV 为空');
  const header = table[0].map((h) => text(h));
  const rows = [];
  let firstRaw = null;
  for (let i = 1; i < table.length; i += 1) {
    const cells = table[i];
    if (cells.length !== header.length) continue;
    const item = {};
    for (let c = 0; c < header.length; c += 1) item[header[c]] = cells[c];
    if (!text(item.repository)) continue;
    if (firstRaw === null) firstRaw = cells; // 跟随**实际入列**的第一行，避免跳过行后错位
    rows.push(boardRow(item, i));
  }
  const rawWindow = { start: '', end: '' };
  if (firstRaw) {
    const idxStart = header.indexOf('window_start');
    const idxEnd = header.indexOf('window_end');
    if (idxStart >= 0) rawWindow.start = text(firstRaw[idxStart]);
    if (idxEnd >= 0) rawWindow.end = text(firstRaw[idxEnd]);
  }
  return {
    rows,
    window: rawWindow.start || rawWindow.end ? rawWindow : null,
  };
}

/** 取三个榜单（互不阻塞：任一失败不影响其它）。 */
async function fetchAllBoards() {
  const jobs = [
    { id: 'day', label: '日榜', run: () => fetchCsvBoard('/data/star-growth-24h.csv') },
    { id: 'week', label: '周榜', run: () => fetchWeekly() },
    { id: 'month', label: '月榜', run: () => fetchCsvBoard('/data/star-growth-30d.csv') },
  ];
  const results = await Promise.all(
    jobs.map(async (job) => {
      const cacheKey = 'board:' + job.id;
      const cached = cacheGet(cacheKey, BOARD_TTL_MS);
      if (cached) return { ...cached, cached: true };
      try {
        const data = await job.run();
        const value = {
          id: job.id,
          label: job.label,
          ok: true,
          fetchedAt: nowIso(),
          rows: data.rows,
          window: data.window,
          week: data.week || null,
          error: null,
        };
        cacheSet(cacheKey, value);
        return { ...value, cached: false };
      } catch (error) {
        const stale = cache.get(cacheKey);
        lastError = { at: nowIso(), scope: job.id, message: String(error && error.message ? error.message : error) };
        // 取数失败：如果有更早的成功结果，标 stale 一并返回（界面显示"这是几点的数据"）
        return {
          id: job.id,
          label: job.label,
          ok: false,
          fetchedAt: null,
          rows: stale ? stale.value.rows : [],
          window: stale ? stale.value.window : null,
          week: stale ? stale.value.week : null,
          error: String(error && error.message ? error.message : error),
          staleAt: stale ? new Date(stale.at).toISOString() : null,
          cached: false,
        };
      }
    }),
  );
  return results;
}

/**
 * 取单项目详情：简介 + 星数曲线。
 *
 * 两件事各自独立失败：简介取不到不影响曲线，曲线解析不出不影响简介。
 * 结果缓存 6 小时（Hysen 的曲线一天才动一次）。
 */
/* ------------------------------------------------------------ 中文翻译 */

/**
 * 简介翻译（用 DSH 自带的模型）。
 *
 * 为什么放在宿主侧：模型调用依赖 ctx.llm，浏览器半侧拿不到；而且翻好的结果要落缓存，
 * 同一句话只翻一次。
 *
 * 三条口径：
 *   1. **只翻不做别的**：只把英文简介翻成中文，不改写、不扩写、不加评论。
 *   2. **按原文缓存**：原文改了就重翻（键是原文的哈希），不拿旧译文指鹿为马。
 *   3. **翻不了就留空**：模型不可用 / 超时 / 答非所问时 descZh 为 null，
 *      界面回退显示英文原文 —— 绝不拿半截英文半截中文糊弄。
 */

/**
 * 翻译结果缓存：key = 原文 sha1，value = zh。
 *
 * 翻译一次要几秒到几十秒，重启后不该重来 —— 所以和榜单缓存一起落盘。
 */
const zhCache = new Map();
const ZH_MAX = 600;
let zhLoaded = false;
let zhFlushTimer = null;

function zhFilePath() {
  const home = process.env.DSH_HOME || join(homedir(), '.dsh');
  return join(home, 'dsh-github-hot', 'zh.json');
}

function ensureZhLoaded() {
  if (zhLoaded) return;
  zhLoaded = true;
  try {
    const file = zhFilePath();
    if (!existsSync(file)) return;
    const data = JSON.parse(readFileSync(file, 'utf8'));
    if (data && typeof data === 'object') {
      for (const [k, v] of Object.entries(data)) {
        if (typeof v === 'string') zhCache.set(k, v);
      }
    }
  } catch {
    /* 读不出来当空 */
  }
}

function scheduleZhFlush() {
  if (zhFlushTimer !== null) return;
  zhFlushTimer = setTimeout(() => {
    zhFlushTimer = null;
    try {
      const file = zhFilePath();
      const dir = join(file, '..');
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      let entries = [...zhCache.entries()];
      if (entries.length > ZH_MAX) entries = entries.slice(-ZH_MAX);
      writeFileSync(file, JSON.stringify(Object.fromEntries(entries)), 'utf8');
    } catch {
      /* 忽略 */
    }
  }, 3000);
  if (typeof zhFlushTimer.unref === 'function') zhFlushTimer.unref();
}

function sha1(input) {
  return createHash('sha1').update(String(input)).digest('hex');
}

function zhCacheGet(text) {
  ensureZhLoaded();
  const hit = zhCache.get(sha1(text));
  return hit ? hit.zh : null;
}

function zhCacheSet(text, zh) {
  ensureZhLoaded();
  zhCache.set(sha1(text), zh);
  scheduleZhFlush();
  if (zhCache.size > ZH_MAX) {
    const keys = [...zhCache.keys()].slice(0, Math.floor(ZH_MAX / 2));
    for (const k of keys) zhCache.delete(k);
  }
}

/** 安全取 DSH 服务（未声明的服务直接属性访问可能抛错）。 */
function service(ctx, name) {
  try {
    if (typeof ctx?.get === 'function') {
      const viaGet = ctx.get(name);
      if (viaGet !== undefined && viaGet !== null) return viaGet;
    }
  } catch {
    /* 落回属性读取 */
  }
  try {
    return ctx?.[name];
  } catch {
    return undefined;
  }
}

/**
 * 惰性加载官方 LLM 包。
 *
 * 裸 import 在 link: 挂载的插件里常常解析不到（插件的 node_modules 里没有这个包），
 * 所以再按 DSH 的目录约定试几个绝对路径；全失败就返回 null，用内置消息结构兜底。
 */
let llmModulePromise;
function llmEntryCandidates() {
  const home = homedir();
  const out = [];
  for (const profile of ['desktop', 'web', 'headless', 'dsh-tui']) {
    out.push(join(home, '.dsh', 'profiles', profile, 'node_modules', '@deepseek-ai', 'dsh-llm', 'lib', 'index.js'));
  }
  // 共享层：~/.dsh/profiles/node_modules
  out.push(join(home, '.dsh', 'profiles', 'node_modules', '@deepseek-ai', 'dsh-llm', 'lib', 'index.js'));
  return out;
}

function loadLlmModule() {
  if (llmModulePromise === undefined) {
    llmModulePromise = (async () => {
      try {
        const mod = await import('@deepseek-ai/dsh-llm');
        if (typeof mod?.createUserMessage === 'function' || typeof mod?.BlockAssembler === 'function') return mod;
      } catch {
        /* 试绝对路径 */
      }
      for (const candidate of llmEntryCandidates()) {
        if (!existsSync(candidate)) continue;
        try {
          const mod = await import(pathToFileURL(candidate).href);
          if (typeof mod?.createUserMessage === 'function' || typeof mod?.BlockAssembler === 'function') return mod;
        } catch {
          /* 试下一个 */
        }
      }
      return null;
    })();
  }
  return llmModulePromise;
}

/** 从流式分片里拼出文本（BlockAssembler 不可用时的兜底）。 */
function textFromChunks(chunks) {
  const parts = [];
  let finish;
  for (const chunk of chunks) {
    if (!chunk || typeof chunk !== 'object') continue;
    if (chunk.type === 'text-delta' && typeof chunk.text === 'string') parts.push(chunk.text);
    else if (chunk.type === 'text' && typeof chunk.text === 'string') parts.push(chunk.text);
    if (chunk.type === 'finish' || chunk.finish) finish = chunk.finish || chunk;
  }
  return { text: parts.join(''), finish };
}

/**
 * 把一段英文简介翻成中文。返回中文字符串，或 null（表示翻不了）。
 * 任何异常都在这里被吃掉 —— 翻译失败不该让整个面板挂掉。
 */
/**
 * 挑一个可用于翻译的模型。
 *
 * resolveModelInfo 的签名是 (provider, model)，空调用必然失败，所以这里必须：
 *   1. 先问宿主「当前默认模型」是什么（agentDefaultModel 服务）；
 *   2. 拿不到就枚举 llm.listProviders()，再对每个 provider 调 listModels()，
 *      取第一个模型。只认**真的有模型**的 provider，不猜。
 * 全都拿不到返回 null —— 翻译降级为「只显示英文」，不影响其它功能。
 */
async function pickModel(ctx, llm) {
  // 1) 宿主默认模型
  try {
    const svc = service(ctx, 'agentDefaultModel');
    const def = typeof svc?.get === 'function' ? svc.get() : svc?.current ?? svc?.value;
    const resolved = await def;
    const provider = resolved?.provider ?? resolved?.providerId;
    const model = resolved?.model ?? resolved?.modelId;
    if (typeof provider === 'string' && typeof model === 'string' && provider && model) {
      return { provider, model };
    }
  } catch {
    /* 继续枚举 */
  }

  // 2) 枚举 provider 与模型
  try {
    if (typeof llm.listProviders === 'function' && typeof llm.listModels === 'function') {
      const providers = await llm.listProviders();
      for (const p of Array.isArray(providers) ? providers : []) {
        const pid = typeof p === 'string' ? p : p?.id ?? p?.provider;
        if (typeof pid !== 'string' || !pid) continue;
        try {
          const models = await llm.listModels(pid);
          const first = Array.isArray(models) ? models[0] : null;
          const mid = typeof first === 'string' ? first : first?.id;
          if (typeof mid === 'string' && mid) return { provider: pid, model: mid };
        } catch {
          /* 这个 provider 没有可用模型，试下一个 */
        }
      }
    }
  } catch {
    /* 放弃 */
  }
  return null;
}

async function translateDesc(ctx, text) {
  const src = String(text || '').trim();
  if (!src) return null;
  const cached = zhCacheGet(src);
  if (cached) return cached;

  const llm = service(ctx, 'llm');
  if (llm === undefined || typeof llm.stream !== 'function') return null;

  // 模型解析：resolveModelInfo(provider, model) 需要显式参数，不能空调用。
  // 顺序：宿主默认模型 → 枚举 provider 取第一个可用模型。
  const picked = await pickModel(ctx, llm);
  if (!picked) return null;
  const { provider, model } = picked;

  const llmMod = await loadLlmModule();
  const system =
    '你是技术编辑。把给定的一段英文项目简介翻译成简体中文。' +
    '要求：只输出译文本身；保留专有名词（项目名、工具名、命令、许可证名）原样不译；' +
    '不要任何解释、前缀、Markdown 或引号；译文长度与原文相当，不超过 120 个汉字。';
  const userText = src;

  const message =
    typeof llmMod?.createUserMessage === 'function'
      ? llmMod.createUserMessage({ content: [{ type: 'text', text: userText }], source: { kind: 'user' } })
      : { id: randomUUID(), role: 'user', content: [{ type: 'text', text: userText }], source: { kind: 'user' } };

  const options = {
    provider,
    model,
    sessionId: 'dsh-github-hot:translate',
    messages: [message],
    system,
    temperature: 0.2,
    reasoningEffort: 'off',
    // 超时缩短到 12 秒：一条译文不值得让用户等 45 秒。
    // 超时的那条会留英文原文，下次进插件再翻（有缓存，只补缺的）。
    signal: AbortSignal.timeout(12000),
  };

  try {
    let raw = '';
    if (typeof llmMod?.BlockAssembler === 'function') {
      const assembler = new llmMod.BlockAssembler();
      for await (const chunk of llm.stream(options)) assembler.push(chunk);
      raw = assembler
        .blocks()
        .filter((b) => b.type === 'text')
        .map((b) => ('text' in b ? b.text : ''))
        .join('');
    } else {
      const chunks = [];
      for await (const chunk of llm.stream(options)) chunks.push(chunk);
      raw = textFromChunks(chunks).text;
    }
    const zh = String(raw || '')
      .replace(/^["'“”「」\s]+|["'“”「」\s]+$/g, '')
      .trim();
    // 基本校验：必须含中文，且不是原文照抄，否则当作失败
    if (!zh || !/[\u4e00-\u9fa5]/.test(zh) || zh === src) return null;
    zhCacheSet(src, zh);
    return zh;
  } catch {
    return null;
  }
}

/**
 * 判断一份已缓存的详情是否「结构够新」。
 *
 * 光靠版本号不够 —— 内存里也可能躺着进程启动后写入、但结构已旧的条目。
 * 这里直接按字段校验：曲线如果有，每个点必须带 date，否则视为无效（触发重取）。
 */
function detailShapeOk(detail) {
  if (!detail || typeof detail !== 'object') return false;
  const chart = detail.chart;
  if (!chart) return true; // 没曲线是允许的（可能只是取不到）
  if (!Array.isArray(chart.series) || chart.series.length === 0) return false;
  return chart.series.every((p) => p && typeof p.date === 'string' && p.date.length === 10);
}

/**
 * 在途去重：同一个项目同时被多处问（批量接口 + 详情弹窗）时只发一轮请求。
 * 没有这个的话，快速点开卡片会把同一页 Hysen 抓两次。
 */
const detailInflight = new Map();

async function fetchDetail(repository) {
  const repo = text(repository);
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) {
    const error = new Error('仓库名格式不对（应形如 owner/repo）');
    error.status = 400;
    throw error;
  }
  const slug = slugOf(repo);
  const pending = detailInflight.get(slug);
  if (pending) return pending;
  const task = fetchDetailInner(repo, slug).finally(() => {
    detailInflight.delete(slug);
  });
  detailInflight.set(slug, task);
  return task;
}

async function fetchDetailInner(repo, slug) {
  const cacheKey = 'detail:' + slug;
  const cached = cacheGet(cacheKey, DETAIL_TTL_MS);
  if (cached && detailShapeOk(cached)) return { ...cached, cached: true };
  if (cached) cache.delete(cacheKey); // 结构过期，丢掉重取

  const [pageResult, chartResult] = await Promise.allSettled([
    fetchText(BASE + '/projects/' + slug),
    fetchText(BASE + '/chart/' + slug + '.svg', { accept: 'image/svg+xml,*/*' }),
  ]);

  let desc = null;
  let descSource = 'none';
  let pageUrl = BASE + '/projects/' + slug;
  let started = null;
  let whatIsIt = null;

  let avatarUrl = null;
  if (pageResult.status === 'fulfilled') {
    const html = pageResult.value;
    avatarUrl = parseAvatarUrl(html);
    const conclusion = parseConclusion(html);
    whatIsIt = parseWhatIsIt(html);
    started = (html.match(/Last updated\s+([A-Z][a-z]+ \d{1,2}, \d{4})/i) || [])[1] || null;
    if (conclusion) {
      desc = conclusion.length > DESC_MAX_CHARS ? conclusion.slice(0, DESC_MAX_CHARS) + '…' : conclusion;
      descSource = 'conclusion';
    } else if (whatIsIt) {
      desc = whatIsIt.length > DESC_MAX_CHARS ? whatIsIt.slice(0, DESC_MAX_CHARS) + '…' : whatIsIt;
      descSource = 'overview';
    }
  }

  let chart = null;
  let chartError = null;
  if (chartResult.status === 'fulfilled') {
    chart = parseChartSvg(chartResult.value);
    if (!chart) chartError = '曲线 SVG 解析失败';
  } else {
    chartError = String(chartResult.reason && chartResult.reason.message ? chartResult.reason.message : chartResult.reason);
  }

  const value = {
    repository: repo,
    slug,
    pageUrl,
    /** 所有者头像的 CDN 直链（从项目页里读出来的）；没有就 null */
    avatarUrl,
    desc,
    descSource,
    whatIsIt,
    analysisUpdated: started,
    chart,
    chartError,
    pageError:
      pageResult.status === 'rejected'
        ? String(pageResult.reason && pageResult.reason.message ? pageResult.reason.message : pageResult.reason)
        : null,
    fetchedAt: nowIso(),
  };
  cacheSet(cacheKey, value);
  return { ...value, cached: false };
}

/* ---------------------------------------------------------------- 路由 */

function sendJson(res, status, payload) {
  const body = Buffer.from(JSON.stringify(payload), 'utf8');
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

/* ------------------------------------------------------------ 头像 */

/**
 * 仓库所有者头像代理。
 *
 * 为什么不让浏览器直接引 `github.com/{owner}.png`：
 *   · 一张卡一次外网请求，20 张卡就是 20 次（还跨域）；
 *   · 每次重开面板都会重下。
 * 所以这里由宿主取一次、缓存起来，浏览器只打本机接口。
 *
 * 头像按 owner 缓存 7 天（头像几乎不变），失败负缓存 10 分钟（免得反复撞墙）。
 */
const AVATAR_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const AVATAR_FAIL_TTL_MS = 10 * 60 * 1000;
const avatarCache = new Map(); // owner -> { at, type, body } | { at, error }

/** 头像按 owner 缓存（含磁盘）：{ at, type, body(base64) } */
function avatarCacheDir() {
  const home = process.env.DSH_HOME || join(homedir(), '.dsh');
  return join(home, 'dsh-github-hot', 'avatars');
}

/** 从磁盘读一张已缓存的头像，返回 { type, body } 或 null。 */
function readAvatarDisk(owner) {
  try {
    // 兜底：文件名只允许安全字符，双保险（调用方已校验过一次）
    if (!/^[A-Za-z0-9-]+$/.test(owner)) return null;
    const file = join(avatarCacheDir(), owner + '.json');
    if (!existsSync(file)) return null;
    const data = JSON.parse(readFileSync(file, 'utf8'));
    if (!data || typeof data.body !== 'string') return null;
    if (Date.now() - Number(data.at || 0) > AVATAR_TTL_MS) return null;
    return { type: data.type || 'image/png', body: Buffer.from(data.body, 'base64') };
  } catch {
    return null;
  }
}

/** 把头像写到磁盘（base64 存 JSON，避免二进制与元数据分开管）。 */
function writeAvatarDisk(owner, entry) {
  try {
    if (!/^[A-Za-z0-9-]+$/.test(owner)) return; // 兜底，绝不把非法名当文件名
    const dir = avatarCacheDir();
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, owner + '.json'),
      JSON.stringify({ at: Date.now(), type: entry.type, body: entry.body.toString('base64') }),
      'utf8',
    );
    pruneAvatarDir(); // 顺带清理过期/超量的头像
  } catch {
    /* 写不进去就只留内存 */
  }
}

/** 头像文件上限：超了就按修改时间删最旧的（目录不能无限长）。 */
const AVATAR_MAX_FILES = 400;

/**
 * 清理头像目录：删掉过期的和超出上限的。
 * 每次写新头像时顺带跑一次，成本很低（只是一次 readdir）。
 */
function pruneAvatarDir() {
  try {
    const dir = avatarCacheDir();
    if (!existsSync(dir)) return;
    const names = readdirSync(dir).filter((n) => n.endsWith('.json'));
    if (names.length <= AVATAR_MAX_FILES) {
      // 数量不多时只清过期的
      const now = Date.now();
      for (const n of names) {
        const file = join(dir, n);
        try {
          const data = JSON.parse(readFileSync(file, 'utf8'));
          if (now - Number(data.at || 0) > AVATAR_TTL_MS) unlinkSync(file);
        } catch {
          unlinkSync(file); // 读不出来的也删掉，别让它一直占位
        }
      }
      return;
    }
    // 超上限：按 mtime 从旧到新删掉多余的
    const items = names.map((n) => {
      const file = join(dir, n);
      let mtime = 0;
      try { mtime = statSync(file).mtimeMs; } catch { /* 忽略 */ }
      return { file, mtime };
    }).sort((a, b) => a.mtime - b.mtime);
    const removeCount = items.length - AVATAR_MAX_FILES;
    for (let i = 0; i < removeCount; i += 1) {
      try { unlinkSync(items[i].file); } catch { /* 忽略 */ }
    }
  } catch {
    /* 清理失败不影响功能 */
  }
}

/**
 * 尝试的图片来源顺序（**都不经过 github.com 的重定向**）：
 *   1. 详情里从 Hysen 项目页抠到的 CDN 直链（最快且最准）
 *   2. GitHub 官方头像 CDN（只要知道用户 id）
 *   3. unavatar.io（第三方聚合，慢一点但覆盖面广）
 */
function avatarSources(owner, knownUrl) {
  const out = [];
  if (knownUrl) out.push(knownUrl);
  out.push('https://unavatar.io/github/' + encodeURIComponent(owner));
  return out;
}

/** 取某个仓库所有者头像（二进制），带内存 + 磁盘两级缓存。 */
async function fetchAvatar(owner, knownUrl) {
  const key = String(owner || '').toLowerCase();

  // ① 内存
  const mem = avatarCache.get(key);
  if (mem) {
    if (mem.body && Date.now() - mem.at < AVATAR_TTL_MS) return mem;
    if (mem.error && Date.now() - mem.at < AVATAR_FAIL_TTL_MS) {
      const err = new Error(mem.error);
      err.status = 502;
      throw err;
    }
  }

  // ② 磁盘（重启后仍然有效）
  const disk = readAvatarDisk(key);
  if (disk) {
    const entry = { at: Date.now(), ...disk };
    avatarCache.set(key, entry);
    return entry;
  }

  // ③ 出网
  let lastError = null;
  for (const url of avatarSources(key, knownUrl)) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await fetch(url, {
        headers: { 'User-Agent': UA, Accept: 'image/*' },
        signal: controller.signal,
        redirect: 'follow',
      });
      if (!response.ok) throw new Error('HTTP ' + response.status);
      const type = response.headers.get('content-type') || 'image/png';
      if (!type.startsWith('image/')) throw new Error('不是图片：' + type);
      const body = Buffer.from(await response.arrayBuffer());
      // 空图 / 1x1 占位都算失败，别把占位图当头像缓存起来
      if (body.length < 200) throw new Error('图片过小（' + body.length + 'B），疑似占位图');
      const entry = { at: Date.now(), type, body };
      avatarCache.set(key, entry);
      writeAvatarDisk(key, entry);
      return entry;
    } catch (error) {
      lastError = error;
    } finally {
      clearTimeout(timer);
    }
  }

  const message = String(lastError && lastError.message ? lastError.message : lastError);
  avatarCache.set(key, { at: Date.now(), error: message });
  const err = new Error(message);
  err.status = 502;
  throw err;
}

async function handleRoute(ctx, req, res) {
  const url = new URL(req.url || '/', 'http://localhost');
  const path = url.pathname.startsWith(ROUTE_PREFIX) ? url.pathname.slice(ROUTE_PREFIX.length) || '/' : url.pathname;

  if (req.method !== 'GET') {
    sendJson(res, 405, { error: '只支持 GET' });
    return;
  }

  try {
    if (path === '/boards' || path === '/') {
      const boards = await fetchAllBoards();
      sendJson(res, 200, {
        ok: true,
        plugin: name,
        version: VERSION,
        fetchedAt: nowIso(),
        boards,
        lastError,
      });
      return;
    }

    if (path === '/detail') {
      const repository = url.searchParams.get('repo') || '';
      const detail = await fetchDetail(repository);
      // 简介翻成中文（拿不到译文就留 null，界面回退英文原文）
      let descZh = null;
      if (detail && detail.desc) {
        try { descZh = await translateDesc(ctx, detail.desc); } catch { descZh = null; }
      }
      sendJson(res, 200, { ok: true, detail: { ...detail, descZh } });
      return;
    }

    /**
     * 批量取详情：一次给一批仓库的简介 + 曲线。
     *
     * 为什么需要它：列表页的卡片要显示简介，一张卡一次请求会把浏览器连接打满，
     * 也会让对方站点承受 30 次并发。这里在宿主侧**串行**取（复用 fetchText 的队列），
     * 并发度由队列天然限成 1，取不到的那几条留空、不阻塞其余。
     *
     *   GET /batch?repos=a/b,c/d&limit=8
     */
    if (path === '/batch') {
      const rawList = (url.searchParams.get('repos') || '').split(',').map(text).filter(Boolean);
      const limit = Math.min(Math.max(Number(url.searchParams.get('limit')) || 8, 1), 20);
      /**
       * 默认**不翻译**，秒回英文简介 + 曲线。
       *
       * 为什么改回来：早期试过「一次取全（含翻译）」，结果是首次打开要等模型
       * 把 20 条全翻完 —— 网络慢的时候十几秒白屏。现在的分工是：
       *   · /batch   ：只取数据（不碰模型），通常 1~2 秒
       *   · /translate：单独翻译，前端拿到数据后再补，界面先用英文顶着
       * 用户选了「中文」时，前端会等翻译；选「English」就直接用英文，一次都不问模型。
       */
      const wantZh = url.searchParams.get('translate') === '1';
      const repos = rawList.slice(0, limit);
      if (repos.length === 0) {
        sendJson(res, 400, { ok: false, error: '缺少 repos 参数' });
        return;
      }
      // 限并发 4：串行取 8 条要一分钟以上，并发后通常在十几秒内
      const slots = new Array(repos.length).fill(null);
      let cursor = 0;
      const worker = async () => {
        for (;;) {
          const i = cursor++;
          if (i >= repos.length) return;
          const repo = repos[i];
          try {
            const detail = await fetchDetail(repo);
            let descZh = null;
            if (wantZh && detail.desc) {
              try { descZh = await translateDesc(ctx, detail.desc); } catch { descZh = null; }
            }
            /**
             * 头像内联成 data URI：20 张卡各自发一个 /avatar 请求会被浏览器的
             * 「同域名 6 并发」限制排队，反而拖慢 /batch。
             *
             * 但这里**不能让头像拖住详情**：头像走独立缓存，命中就极快；
             * 没命中时最多等 3 秒就放弃（界面用首字母块顶着，下次再取）。
             */
            let avatar = null;
            try {
              const owner = repo.split('/')[0];
              const av = await Promise.race([
                fetchAvatar(owner, detail.avatarUrl || null),
                new Promise((resolve) => setTimeout(() => resolve(null), 3000)),
              ]);
              if (av && av.body && av.body.length > 0) {
                avatar = 'data:' + av.type + ';base64,' + av.body.toString('base64');
              }
            } catch {
              avatar = null; // 取不到就让界面用首字母块
            }
            slots[i] = {
              repository: repo,
              desc: detail.desc,
              descZh,
              descSource: detail.descSource,
              chart: detail.chart,
              chartError: detail.chartError,
              avatar,
            };
          } catch (error) {
            slots[i] = {
              repository: repo,
              desc: null,
              descZh: null,
              descSource: 'none',
              chart: null,
              chartError: String(error && error.message ? error.message : error),
            };
          }
        }
      };
      await Promise.all(Array.from({ length: Math.min(FETCH_CONCURRENCY, repos.length) }, worker));
      const items = slots.filter(Boolean);
      sendJson(res, 200, { ok: true, items });

      /**
       * 响应发出去之后再**后台预翻译**（不 await，不拖慢这次响应）。
       * 用户此刻看到的是英文；等他切到「中文」时，译文大多已经热好了。
       */
      if (wantZh !== true) {
        void prewarmTranslation(ctx, items.map((it) => ({ desc: it.desc, repository: it.repository })));
      }
      return;
    }

    /** 诊断：把「能不能翻译」的每一步都摊开，便于定位（只读，不花钱）。 */
    if (path === '/diag') {
      const llm = service(ctx, 'llm');
      const out = {
        hasLlm: llm !== undefined,
        llmType: typeof llm,
        hasStream: typeof llm?.stream,
        hasListProviders: typeof llm?.listProviders,
        hasListModels: typeof llm?.listModels,
        providers: null,
        picked: null,
        llmModule: null,
        translateSample: null,
      };
      try {
        const mod = await loadLlmModule();
        out.llmModule = mod ? 'loaded' : 'null';
      } catch (e) {
        out.llmModule = 'error: ' + String(e && e.message ? e.message : e);
      }
      try {
        const provs = await llm?.listProviders?.();
        out.providers = Array.isArray(provs) ? provs.map((x) => (typeof x === 'string' ? x : x?.id ?? x?.provider)) : String(provs);
      } catch (e) {
        out.providers = 'error: ' + String(e && e.message ? e.message : e);
      }
      try {
        out.picked = await pickModel(ctx, llm);
      } catch (e) {
        out.picked = 'error: ' + String(e && e.message ? e.message : e);
      }
      try {
        out.translateSample = await translateDesc(ctx, 'A fast web framework for Node.js.');
      } catch (e) {
        out.translateSample = 'error: ' + String(e && e.message ? e.message : e);
      }
      sendJson(res, 200, { ok: true, diag: out });
      return;
    }

    /**
     * 批量翻译：给一批仓库的简介做中译。
     * 前端先拿到英文简介秒开，再调这个接口把中文补上 —— 首屏不被模型拖慢。
     * 串行调用（复用同一条队列），单条失败留 null，不阻塞其余。
     */
    if (path === '/translate') {
      const rawList = (url.searchParams.get('repos') || '').split(',').map(text).filter(Boolean);
      const limit = Math.min(Math.max(Number(url.searchParams.get('limit')) || 8, 1), 20);
      const repos = rawList.slice(0, limit);
      if (repos.length === 0) {
        sendJson(res, 400, { ok: false, error: '缺少 repos 参数' });
        return;
      }
      // 限并发 4：比完全串行快得多，又不至于把模型打到限流
      const results = new Array(repos.length).fill(null);
      let cursor = 0;
      const worker = async () => {
        for (;;) {
          const i = cursor++;
          if (i >= repos.length) return;
          const repo = repos[i];
          try {
            const detail = await fetchDetail(repo);
            let descZh = null;
            if (detail.desc) descZh = await translateDesc(ctx, detail.desc);
            results[i] = { repository: repo, descZh };
          } catch {
            results[i] = { repository: repo, descZh: null };
          }
        }
      };
      await Promise.all(Array.from({ length: Math.min(TRANSLATE_CONCURRENCY, repos.length) }, worker));
      sendJson(res, 200, { ok: true, items: results.filter(Boolean) });
      return;
    }

    /**
     * 头像：/avatar?repo=owner/name 或 /avatar?owner=xxx
     * 直接回图片字节；取不到回 1x1 透明 PNG（界面自己降级成首字母块）。
     */
    if (path === '/avatar') {
      const repo = url.searchParams.get('repo') || '';
      const ownerParam = url.searchParams.get('owner') || '';
      const owner = ownerParam || (repo.includes('/') ? repo.split('/')[0] : '');
      if (!owner) {
        sendJson(res, 400, { ok: false, error: '缺少 owner' });
        return;
      }
      /**
       * 严格校验 owner：只允许 GitHub 用户名/组织名的合法字符。
       * 不校验的话，`../../etc/passwd` 这类值会被拼进 URL 和**本地缓存文件名**，
       * 造成路径穿越（写到 avatars/ 目录之外）。
       */
      if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(owner)) {
        sendJson(res, 400, { ok: false, error: 'owner 格式不合法' });
        return;
      }
      // 如果详情已经取过，就直接用它从 Hysen 页面抠到的 CDN 直链（免去猜 id）
      let knownUrl = null;
      const slug = repo.includes('/') ? slugOf(repo) : null;
      if (slug) {
        const cached = cacheGet('detail:' + slug, DETAIL_TTL_MS);
        if (cached && cached.avatarUrl) knownUrl = cached.avatarUrl;
      }
      try {
        const entry = await fetchAvatar(owner, knownUrl);
        res.writeHead(200, {
          'Content-Type': entry.type,
          'Content-Length': entry.body.length,
          'Cache-Control': 'public, max-age=86400',
        });
        res.end(entry.body);
      } catch {
        // 1x1 透明 PNG
        const px = Buffer.from(
          'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
          'base64',
        );
        res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': px.length, 'Cache-Control': 'no-store' });
        res.end(px);
      }
      return;
    }

    /**
     * 版本检查：告诉前端「有没有新版本」。
     *
     * 为什么放在宿主侧而不是浏览器直接查 npm：
     *   · 浏览器跨域请求 npm registry 会被 CORS 拦；
     *   · 顺便可以做缓存，避免每次开面板都打一次 npm。
     *
     * 缓存策略：每天最多查一次（数据源思路一致，不需要分钟级）。
     * npm 查询失败不影响插件使用，返回 checked:false 即可。
     */
    if (path === '/update') {
      const force = url.searchParams.get('force') === '1';
      const hit = cacheGet(UPDATE_CACHE_KEY, UPDATE_TTL_MS);
      if (hit && !force) {
        sendJson(res, 200, { ok: true, ...hit, cached: true });
        return;
      }
      let latest = null;
      let error = null;
      try {
        const raw = await fetchText('https://registry.npmjs.org/' + name + '/latest', {
          accept: 'application/json',
          timeout: 8000,
        });
        const parsed = JSON.parse(raw);
        latest = parsed && parsed.version ? String(parsed.version) : null;
      } catch (e) {
        error = String(e && e.message ? e.message : e);
      }
      const payload = {
        current: VERSION,
        latest,
        hasUpdate: latest ? compareVersion(latest, VERSION) > 0 : false,
        checkedAt: nowIso(),
        error,
      };
      // 查到了才缓存；失败不缓存，下次还能重试
      if (latest) cache.set(UPDATE_CACHE_KEY, { at: Date.now(), value: payload });
      sendJson(res, 200, { ok: true, ...payload, cached: false });
      return;
    }

    if (path === '/status') {
      sendJson(res, 200, {
        ok: true,
        plugin: name,
        version: VERSION,
        cacheSize: cache.size,
        lastError,
      });
      return;
    }

    sendJson(res, 404, { error: '未知路径：' + path });
  } catch (error) {
    const status = error && error.status ? error.status : 500;
    lastError = { at: nowIso(), scope: path, message: String(error && error.message ? error.message : error) };
    sendJson(res, status, { ok: false, error: String(error && error.message ? error.message : error) });
  }
}

/* ---------------------------------------------------------------- 入口 */

export function apply(ctx) {
  const logger = ctx.logger || console;

  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'prefix',
        path: ROUTE_PREFIX,
        handler: (req, res) => {
          void handleRoute(ctx, req, res);
        },
      }),
    'dsh-github-hot: /dsh-github-hot routes',
  );

  logger.info?.('[dsh-github-hot] 已加载 v' + VERSION + '：数据源 hysenlabs.com（日/周/月榜 + 星数曲线 + 项目简介）');
}

/** 仅供测试：解析函数都是纯函数，值得直接钉住。 */
export const __internals = {
  parseCsv,
  parseWeeklyHtml,
  parseChartSvg,
  parseConclusion,
  parseWhatIsIt,
  slugOf,
  currentWeekMonday,
  dayKeyInSourceTz,
  SOURCE_TZ,
  parseAxisDate,
  handleRoute,
  parseAvatarUrl,
  fetchAvatar,
  compareVersion,
  detailShapeOk,
  cacheGet,
  cacheSet,
  localDayKey,
  DAY_MS,
  /** 仅供测试：直接拿到缓存表，用来伪造写入时间 */
  __cache: cache,
};
