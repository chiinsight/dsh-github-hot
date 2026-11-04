/**
 * dsh-github-hot —— 浏览器半侧（client half）
 *
 * ## 契约（与 dsh-pet / 官方插件一致）
 *   · 本文件由 DSH 当**普通副作用脚本**加载（`/plugins/dsh-github-hot/client.js`）：
 *     顶层**不能有 import / export**；
 *   · 必须调 `window.__ModuleLoader__.load({ id, factory })` 自我注册；
 *   · react / react-dom 由 factory 的 `require` 取得；factory 返回 `{ name, inject, apply }`。
 *
 * ## 这个插件的主打：可视化
 *
 * 三个视图，一套数据：
 *
 *   ① 卡片流（默认）—— 榜单像一排排「成绩卡」：大号涨星数、涨幅条、名次徽章、
 *      语言/许可证小标签。前三名金银铜，涨星量渲染成粗细不同的进度条。
 *   ② 详情视图    —— 点一张卡，右侧展开：项目独立简介 +
 *      **星数曲线（股票式折线）**：从 SVG 解析出的真实星数，画成带面积填充的趋势图，
 *      标注起点/终点/期间涨了多少。
 *   ③ 大盘视图    —— 当前榜单的宏观统计：涨星分布、语言占比、涨幅分布（纯 CSS/内联 SVG）。
 *
 * 三个周期（日/周/月）在顶部一个分段器里切换，切换即换数据，不重载页面。
 *
 * ## 颜色
 * 全部走 DSH 设计 token（`--dsw-*`）并带兜底值；涨跌色用插件自己的局部变量
 * （只在 `.hp-root` 内定义，不碰全局，避免和皮肤插件打架）。
 */
(function () {
  /** 宿主路由前缀，必须与 lib/index.js 的 ROUTE_PREFIX 一致。 */
  const BASE = '/dsh-github-hot';
  const STYLE_ID = 'dsh-github-hot/styles';
  const PLUGIN_NAME = 'dsh-github-hot';

  /**
   * 折线上涨图标 —— 就一条折线 + 末端箭头，跟侧栏里「GitHub 热榜 / 趋势」同款画法。
   *
   * 之前那版是三条并行线 + 彩色 + 圆点，塞进 18px 的侧栏里糊成一团。
   * 单线条在这么小的尺寸下才认得出来，也才跟旁边两个插件看起来是一套的。
   */
  const LINE_ICON = (size) =>
    '<svg width="' + size + '" height="' + size + '" viewBox="0 0 24 24" fill="none" ' +
    'xmlns="http://www.w3.org/2000/svg" aria-hidden="true">' +
    '<path d="M3 17.5 L8.5 12 L12 15.5 L21 6.5" stroke="currentColor" stroke-width="2.2" ' +
    'stroke-linecap="round" stroke-linejoin="round"/>' +
    '<path d="M15.5 6.5 L21 6.5 L21 12" stroke="currentColor" stroke-width="2.2" ' +
    'stroke-linecap="round" stroke-linejoin="round"/>' +
    '</svg>';

  /** 侧栏图标（走文字色，深浅主题自动适配）。 */
  const SIDEBAR_ICON_SVG = LINE_ICON(18);
  /** 面板标题图标，稍大一点。 */
  const BRAND_ICON_SVG = LINE_ICON(18);

  /** 榜单最多展示多少项。超过 20 条会变成信息噪音，所以硬性截断，不提供「再显示」。 */
  const MAX_ITEMS = 20;
  /** 统计页默认对比前几个（再多线就分不清了）。 */
  const DEFAULT_COMPARE = 10;
  /** 统计页最多允许同时对比几个。 */
  const MAX_COMPARE = 20;

  /* ============================================================ 工具函数 */

  /** 主题：dark（融入 DSH）/ paper（纸感贴纸）。存 localStorage，默认跟随深色。 */
  const THEME_KEY = 'dsh-github-hot:theme';
  function readTheme() {
    try {
      const v = localStorage.getItem(THEME_KEY);
      return v === 'paper' ? 'paper' : 'dark';
    } catch (e) { return 'dark'; }
  }
  function writeTheme(t) {
    try { localStorage.setItem(THEME_KEY, t); } catch (e) { /* 隐私模式忽略 */ }
  }

  /**
   * 语言偏好：zh = 等中文（不闪，但首屏要等模型几秒）
   *             en = 直接显示英文原文（快，不问模型）
   * 存在 localStorage 里，下次打开沿用。
   */
  const LANG_KEY = 'dsh-github-hot:lang';
  function readLang() {
    try {
      return localStorage.getItem(LANG_KEY) === 'en' ? 'en' : 'zh';
    } catch (e) { return 'zh'; }
  }
  function writeLang(v) {
    try { localStorage.setItem(LANG_KEY, v); } catch (e) { /* 忽略 */ }
  }

  /**
   * 紧凑数字格式：1000 以上一律走 k，避免卡片里「3,988」和「13.2k」混排显得参差。
   * 注意保留一位小数但去掉多余的 .0（3,988 → 4.0k → 4k）。
   */
  function fmtCount(n) {
    if (n === null || n === undefined || Number.isNaN(Number(n))) return '—';
    const v = Number(n);
    const abs = Math.abs(v);
    if (abs >= 1000000) return (v / 1000000).toFixed(1).replace(/\.0$/, '') + 'M';
    if (abs >= 1000) return (v / 1000).toFixed(1).replace(/\.0$/, '') + 'k';
    return v.toLocaleString('en-US');
  }

  /** 涨星数带正号，并分档给颜色。 */
  function gainTone(n) {
    if (n === null || n === undefined) return 'flat';
    return n > 0 ? 'up' : n < 0 ? 'down' : 'flat';
  }

  function fmtPct(n) {
    if (n === null || n === undefined || Number.isNaN(Number(n))) return '—';
    const v = Number(n);
    return (v > 0 ? '+' : '') + (Math.abs(v) >= 100 ? v.toFixed(0) : v.toFixed(1)) + '%';
  }

  /**
   * 详情本地缓存（localStorage）。
   *
   * 为什么需要：后端虽然缓存了，但前端每次进入插件都会重建组件、重新请求一遍，
   * 用户看到的是「骨架 → 内容」的闪烁，感觉像在重新下载。这里把取回的详情按
   * 自然日存在浏览器里 —— 同一自然日再进来直接秒出，后台再静默核对一次。
   *
   * 只存到当天：数据源每天才更新一次，跨天必须重取，不能拿昨天的当今天。
   */
  const DETAILS_KEY = 'dsh-github-hot:details';
  const DETAILS_MAX = 60;

  function readDetailsCache() {
    try {
      const raw = localStorage.getItem(DETAILS_KEY);
      if (!raw) return {};
      const data = JSON.parse(raw);
      if (!data || data.day !== localDayKey() || !data.entries) return {}; // 跨天或格式不对 → 丢弃
      // 逐条校验结构：settled 必须是 true（否则会一直显示骨架），
      // 有曲线的必须每个点带 date（否则统计页画不出来）。不合格的直接丢掉重取。
      const out = {};
      for (const [repo, entry] of Object.entries(data.entries)) {
        if (!entry || entry.settled !== true) continue;
        const chart = entry.chart;
        if (chart && Array.isArray(chart.series)) {
          const okShape = chart.series.length === 0 || chart.series.every((p) => p && typeof p.date === 'string');
          if (!okShape) continue;
        }
        out[repo] = entry;
      }
      return out;
    } catch (e) {
      return {};
    }
  }

  function writeDetailsCache(entries) {
    try {
      // 只留最近的若干条，避免 localStorage 撑爆
      const all = Object.entries(entries || {});
      const keep = all.slice(-DETAILS_MAX);
      localStorage.setItem(DETAILS_KEY, JSON.stringify({ day: localDayKey(), entries: Object.fromEntries(keep) }));
    } catch (e) {
      /* 配额满/隐私模式：忽略，退化成纯内存 */
    }
  }

  /**
   * 数据源时区（Asia/Shanghai）下的日期串 YYYY-MM-DD。
   *
   * 前端也要用数据源时区判断「是不是同一天」：命令里的缓存是否失效、数据是否更新，
   * 都应该跟着**数据源**的日历走，而不是用户所在时区。否则纽约用户在晚上看到的
   * 「今天」和上海用户看到的不一样，缓存也会在奇怪的时间点失效。
   */
  const SOURCE_TZ = 'Asia/Shanghai';
  function localDayKey(ts) {
    const d = ts ? new Date(ts) : new Date();
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: SOURCE_TZ, year: 'numeric', month: '2-digit', day: '2-digit',
    }).formatToParts(d);
    const g = (t) => (parts.find((x) => x.type === t) || {}).value;
    return g('year') + '-' + g('month') + '-' + g('day');
  }

  /**
   * 把数据日期说成一句人话：「11月3日」。
   * 日榜/月榜窗口的 end 是 YYYY-MM-DD；周榜拿 week 的周一开始日算周日。
   */
  /**
   * 把数据日期说成一句人话，例如「11月3日」。
   *
   * ⚠️ 不要用 new Date('2026-11-03') 再取本地月份 —— 那会按 UTC 解析，
   * 在 UTC-x 的时区里显示成「11月2日」。这里**直接切字符串**，日期串本来就是
   * 数据源的日期，不需要经过任何时区换算。
   */
  function dataDateText(board) {
    if (!board) return '今日';
    const raw = board.window && board.window.end ? board.window.end : board.week;
    if (!raw) return '今日';
    const m = String(raw).match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (!m) return '今日';
    return Number(m[2]) + '月' + Number(m[3]) + '日';
  }

  function fmtTime(iso) {
    if (!iso) return '—';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '—';
    return d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false });
  }

  function ago(iso) {
    if (!iso) return '—';
    const ms = Date.now() - new Date(iso).getTime();
    if (!Number.isFinite(ms) || ms < 0) return '—';
    const min = Math.floor(ms / 60000);
    if (min < 1) return '刚刚';
    if (min < 60) return min + ' 分钟前';
    const h = Math.floor(min / 60);
    if (h < 24) return h + ' 小时前';
    return Math.floor(h / 24) + ' 天前';
  }

  /** 简易 fetch JSON（带超时）。 */
  async function getJson(path) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30000);
    try {
      const response = await fetch(BASE + path, { signal: controller.signal, headers: { Accept: 'application/json' } });
      const body = await response.json().catch(() => ({}));
      if (!response.ok || body.ok === false) {
        throw new Error(body.error || 'HTTP ' + response.status);
      }
      return body;
    } finally {
      clearTimeout(timer);
    }
  }

  /* ============================================================ 样式表 */

  function ensureCss(doc) {
    if (doc.getElementById(STYLE_ID)) return;
    const style = doc.createElement('style');
    style.id = STYLE_ID;
    style.textContent = `
/* ---------- 根容器：局部色板，不碰全局 --dsw-* ---------- */
/* ============================================================
   两套主题
   ============================================================
   .hp-dark  —— 深色：融进 DSH 原生界面（默认）
   .hp-paper —— 纸感贴纸风：暖米白纸 + 墨黑粗框 + 实体阴影

   两套只换变量，不改结构；所有组件都只读 --hp-* 变量，天然双主题。
   ============================================================ */
.hp-root{height:100%;display:flex;flex-direction:column;overflow:hidden;font-size:14px}

/* ---------- 深色主题（默认）---------- */
.hp-root.hp-dark{
  --hp-up:#e5484d;
  --hp-up-soft:rgba(229,72,77,.13);
  --hp-down:#30a46c;
  --hp-gold:#d9a52b;
  --hp-silver:#9aa4b2;
  --hp-bronze:#c07a3e;
  --hp-accent:#7b5cff;
  --hp-bg:var(--dsw-alias-bg-layer-1,#14161a);
  --hp-surface:var(--dsw-alias-bg-layer-2,rgba(255,255,255,.035));
  --hp-surface-2:var(--dsw-alias-bg-layer-3,rgba(255,255,255,.07));
  --hp-fg:var(--dsw-alias-label-primary,#e8eaed);
  --hp-fg-2:var(--dsw-alias-label-secondary,rgba(255,255,255,.72));
  --hp-fg-3:var(--dsw-alias-label-tertiary,rgba(255,255,255,.45));
  --hp-line:var(--dsw-alias-border-l2,rgba(255,255,255,.09));
  --hp-sep:var(--dsw-alias-separator-primary,rgba(255,255,255,.08));
  --hp-border:1px solid var(--hp-line);
  --hp-shadow:none;
  --hp-shadow-hover:0 8px 24px rgba(0,0,0,.28);
  --hp-card-bg:var(--hp-surface);
  --hp-radius:13px;
}

/* ---------- 纸感贴纸主题 ---------- */
.hp-root.hp-paper{
  --hp-up:#ff5c2b;
  --hp-up-soft:rgba(255,92,43,.14);
  --hp-down:#3f8f2e;
  --hp-gold:#ffd84d;
  --hp-silver:#cfc8bb;
  --hp-bronze:#ffb07a;
  --hp-accent:#ff5c2b;
  --hp-paper:#fff4dd;
  --hp-ink:#26201a;
  --hp-card:#fffdf7;
  --hp-bg:var(--hp-paper);
  --hp-surface:var(--hp-card);
  --hp-surface-2:#fff9ec;
  --hp-fg:var(--hp-ink);
  --hp-fg-2:#4a3f33;
  --hp-fg-3:#8a7a68;
  --hp-line:var(--hp-ink);
  --hp-sep:rgba(38,32,26,.16);
  --hp-border:2px solid var(--hp-ink);
  --hp-shadow:4px 4px 0 var(--hp-ink);
  --hp-shadow-hover:6px 6px 0 var(--hp-ink);
  --hp-card-bg:var(--hp-card);
  --hp-radius:14px;
}

.hp-root{
  font-family:var(--dsw-font,-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif);
  color:var(--hp-fg);
  background:var(--hp-bg);
}
.hp-root.hp-paper .hp-head{background:#fff9ec}
.hp-root.hp-paper .hp-seg{border:2px solid var(--hp-ink);box-shadow:2px 2px 0 var(--hp-ink);background:var(--hp-card)}
.hp-root.hp-paper .hp-brand-dot{box-shadow:none;border:2px solid var(--hp-ink)}
.hp-root.hp-paper{font-family:'Baloo 2',var(--dsw-font,-apple-system,'PingFang SC','Microsoft YaHei',sans-serif)}
.hp-root.hp-paper .hp-num,.hp-root.hp-paper .hp-gain-v,.hp-root.hp-paper .hp-kpi-v{
  font-family:ui-monospace,'SF Mono',Menlo,Consolas,monospace;
  letter-spacing:-.02em;
}
.hp-scroll{overflow:auto;flex:1;scrollbar-width:thin}
.hp-scroll::-webkit-scrollbar{width:8px;height:8px}
.hp-scroll::-webkit-scrollbar-thumb{background:var(--dsw-alias-scrollbar-bg-l2,rgba(255,255,255,.12));border-radius:4px}

/* ---------- 顶栏 ---------- */
.hp-head{display:flex;align-items:center;gap:10px;padding:11px 18px;border-bottom:1px solid var(--hp-sep);flex-wrap:nowrap;overflow:hidden}
.hp-brand{display:flex;align-items:center;gap:8px;font-weight:650;font-size:14.5px;letter-spacing:.2px;flex:0 0 auto;white-space:nowrap}
.hp-brand-icon{display:inline-flex;align-items:center;justify-content:center;width:18px;height:18px}
.hp-brand-icon svg{display:block}
/* 侧栏图标：与同侧栏其它插件一致，只吃文字色 */
.hp-side-icon{display:inline-flex;align-items:center;justify-content:center;width:18px;height:18px}
.hp-side-icon svg{display:block}
.hp-brand-dot{width:9px;height:9px;border-radius:50%;background:linear-gradient(135deg,var(--hp-grad-a),var(--hp-grad-b));box-shadow:0 0 10px rgba(122,92,255,.7)}
.hp-brand-sub{font-size:10.5px;font-weight:400;color:var(--hp-fg-3);margin-left:2px;white-space:nowrap}
@media (max-width:1180px){.hp-brand-sub{display:none}}
@media (max-width:980px){.hp-head .hp-meta{display:none}}
.hp-seg{display:flex;background:var(--dsw-alias-bg-layer-2,rgba(255,255,255,.05));border:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.08));border-radius:9px;padding:3px;gap:2px}
.hp-seg button{border:0;background:transparent;color:var(--dsw-alias-label-secondary,rgba(255,255,255,.65));font:inherit;font-size:12.5px;padding:5px 11px;border-radius:7px;cursor:pointer;transition:all .16s}
.hp-seg button:hover{color:var(--dsw-alias-label-primary,#fff);background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.06))}
.hp-seg button.on{background:var(--dsw-alias-button-primary-fill,#4f7cff);color:#fff;font-weight:600}
.hp-root.hp-paper .hp-seg button{color:var(--hp-ink)}
.hp-root.hp-paper .hp-seg button.on{background:var(--hp-ink);color:var(--hp-gold);font-weight:800}
.hp-root.hp-paper .hp-seg button:hover:not(.on){background:#f0e6d2;color:var(--hp-ink)}
.hp-seg button:disabled{opacity:.45;cursor:default}
.hp-spacer{flex:1}
.hp-meta{font-size:12px;color:var(--hp-fg-3);display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.hp-dot{width:6px;height:6px;border-radius:50%;display:inline-block;margin-right:5px}
.hp-dot.ok{background:#30a46c;box-shadow:0 0 6px rgba(48,164,108,.8)}
.hp-dot.bad{background:#e5484d}
.hp-dot.warn{background:#f5a524}
.hp-btn{border:1px solid var(--hp-line);background:var(--hp-surface);color:var(--hp-fg);font:inherit;font-size:12.5px;padding:5px 11px;white-space:nowrap;border-radius:8px;cursor:pointer;transition:all .16s}
.hp-btn:hover:not(:disabled){background:var(--hp-surface-2)}
.hp-root.hp-paper .hp-btn{border:2px solid var(--hp-ink);box-shadow:2px 2px 0 var(--hp-ink);font-weight:700}
.hp-root.hp-paper .hp-btn:hover:not(:disabled){transform:translate(-1px,-1px);box-shadow:3px 3px 0 var(--hp-ink)}
.hp-root.hp-paper .hp-btn:active:not(:disabled){transform:translate(1px,1px);box-shadow:1px 1px 0 var(--hp-ink)}
.hp-btn:disabled{opacity:.5;cursor:default}
.hp-btn.primary{background:var(--hp-accent);border-color:transparent;color:#fff;font-weight:600}
.hp-root.hp-paper .hp-btn.primary{background:var(--hp-gold);color:var(--hp-ink);border:2px solid var(--hp-ink)}

/* ---------- 空/错状态 ---------- */
.hp-empty{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:12px;padding:70px 24px;color:var(--dsw-alias-label-tertiary,rgba(255,255,255,.5));text-align:center}
.hp-empty strong{color:var(--dsw-alias-label-secondary,rgba(255,255,255,.7));font-size:15px}
.hp-empty code{font-size:12px;background:var(--dsw-alias-bg-layer-2,rgba(255,255,255,.06));padding:2px 7px;border-radius:5px}
.hp-banner{margin:12px 20px 0;padding:10px 14px;border-radius:9px;font-size:12.5px;line-height:1.55}
.hp-banner.err{background:rgba(229,72,77,.1);border:1px solid rgba(229,72,77,.35);color:#ff9ba0}
.hp-banner.warn{background:rgba(245,165,36,.1);border:1px solid rgba(245,165,36,.35);color:#ffcf80}

/* ---------- 榜单卡片流 ---------- */


/* ---------- 统计视图：多曲线对比 ---------- */
/* 上图下选：图表独占一行，勾选列表在下方横向铺开 */
.hp-dash{display:flex;flex-direction:column;gap:12px;padding:16px 18px 28px}
.hp-picker{border:var(--hp-border);border-radius:var(--hp-radius);background:var(--hp-card-bg);box-shadow:var(--hp-shadow);padding:11px 6px 8px;max-height:230px;overflow:auto}
.hp-picker-list{display:grid;grid-template-columns:repeat(auto-fill,minmax(210px,1fr));gap:1px 4px}
.hp-picker-title{display:flex;justify-content:space-between;align-items:baseline;font-size:11.5px;font-weight:650;color:var(--hp-fg-3);padding:0 10px 8px;border-bottom:1px solid var(--hp-sep);margin-bottom:6px}
.hp-picker-n{font-variant-numeric:tabular-nums}
.hp-pick{display:flex;align-items:center;gap:7px;padding:6px 10px;border-radius:8px;cursor:pointer;font-size:12.5px;transition:background .12s}
.hp-pick:hover{background:var(--hp-surface-2)}
.hp-pick input{accent-color:var(--hp-accent);margin:0;cursor:pointer}
.hp-pick-dot{width:8px;height:8px;border-radius:50%;flex:0 0 auto;background:var(--hp-sep)}
.hp-pick-name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--hp-fg-2)}
.hp-pick.on .hp-pick-name{color:var(--hp-fg);font-weight:600}
.hp-pick-v{font-size:11.5px;font-variant-numeric:tabular-nums;color:var(--hp-up);font-weight:650}
.hp-pick.no-data{opacity:.42;cursor:not-allowed}
.hp-mchart-panel{border:var(--hp-border);border-radius:var(--hp-radius);background:var(--hp-card-bg);box-shadow:var(--hp-shadow);padding:13px 15px 11px;min-width:0}
.hp-mchart-head{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:8px;flex-wrap:wrap}
.hp-mchart-title{font-size:13px;font-weight:700;color:var(--hp-fg)}
.hp-mchart-hint{font-size:11px;color:var(--hp-fg-3)}
.hp-seg.tiny button{font-size:11.5px;padding:3px 9px}
.hp-mchart-svg{width:100%;height:auto;display:block}
/* 换榜单时图表淡入：直接替换会「啪」地跳一下 */
.hp-mchart{animation:hp-chart-in .32s cubic-bezier(.22,.61,.36,1)}
@keyframes hp-chart-in{
  from{opacity:0;transform:translateY(6px)}
  to{opacity:1;transform:translateY(0)}
}
@media (prefers-reduced-motion:reduce){.hp-mchart{animation:none}}
.hp-grid{stroke:var(--hp-sep);stroke-width:1;stroke-dasharray:3 4}
.hp-zero{stroke:var(--hp-fg-3);stroke-width:1.2}
.hp-axis{fill:var(--hp-fg-3);font-size:10.5px;font-family:ui-monospace,Menlo,monospace}
.hp-legend{display:flex;flex-wrap:wrap;gap:8px 14px;margin-top:9px;padding-top:9px;border-top:1px solid var(--hp-sep)}
.hp-legend-item{display:flex;align-items:center;gap:6px;border:0;background:transparent;color:var(--hp-fg-2);font:inherit;font-size:11.5px;cursor:pointer;padding:2px 4px;border-radius:6px;transition:all .12s}
.hp-legend-item:hover,.hp-legend-item.act{background:var(--hp-surface-2);color:var(--hp-fg)}
.hp-legend-line{width:16px;height:3px;border-radius:2px;flex:0 0 auto}
.hp-mchart-note{font-size:11px;color:var(--hp-fg-3);margin-top:9px;line-height:1.5}


/* ---------- 头像 ---------- */
.hp-avatar{flex:0 0 auto;border-radius:9px;object-fit:cover;background:var(--hp-surface-2);display:block}
.hp-root.hp-paper .hp-avatar{border:2px solid var(--hp-ink)}
.hp-avatar-fb{display:inline-flex;align-items:center;justify-content:center;color:#fff;font-weight:700;border-radius:9px;flex:0 0 auto;user-select:none}

/* ---------- 右侧操作区 ---------- */
/* ---------- 数据署名（CC BY 4.0 要求，放右下角不干扰主视觉）---------- */
.hp-attr{
  display:flex;justify-content:flex-end;align-items:center;gap:5px;
  padding:10px 22px 12px;margin-top:auto;
  font-family:ui-monospace,'SF Mono',Menlo,Consolas,monospace;
  font-size:10px;letter-spacing:.02em;
  color:var(--hp-fg-3);opacity:.6;
  transition:opacity .18s;
}
.hp-attr:hover{opacity:.95}
.hp-attr-dot{opacity:.5;margin:0 1px}
.hp-attr a{
  color:inherit;text-decoration:none;
  border-bottom:1px solid transparent;transition:border-color .18s;
}
.hp-attr a:hover{border-bottom-color:currentColor}
/* 纸感主题下用墨色细线，不突兀 */
.hp-root.hp-paper .hp-attr{opacity:.55}
.hp-root.hp-paper .hp-attr:hover{opacity:.85}
.hp-actions{display:flex;align-items:center;gap:8px;flex-wrap:nowrap;flex:0 0 auto;margin-left:auto}
.hp-head .hp-meta{flex:1 1 auto;min-width:0;justify-content:flex-end;overflow:hidden;white-space:nowrap}
/* ---------- 简介：中文优先 ---------- */
.hp-zh-pending{display:inline-block;margin-left:6px;font-size:10px;padding:0 4px;border-radius:4px;background:var(--hp-surface-2);color:var(--hp-fg-3);vertical-align:middle}
.hp-desc.zh{font-family:var(--dsw-font,-apple-system,'PingFang SC','Microsoft YaHei',sans-serif);letter-spacing:.01em;line-height:1.65}
.hp-intro.zh{font-size:13.5px;line-height:1.75;color:var(--hp-fg)}
.hp-intro-en{font-size:12px;line-height:1.65;color:var(--hp-fg-3);margin-top:10px;padding-top:9px;border-top:1px dashed var(--hp-sep)}

/* ---------- 首屏主角（先给答案）---------- */
.hp-hero{display:flex;gap:18px;align-items:stretch;padding:18px 20px 6px;flex-wrap:wrap}
.hp-hero-main{flex:1 1 320px;min-width:260px;border:var(--hp-border);border-radius:var(--hp-radius);background:var(--hp-card-bg);box-shadow:var(--hp-shadow);padding:16px 20px 15px}
.hp-hero-k{font-size:11.5px;font-weight:600;letter-spacing:.06em;color:var(--hp-fg-3);margin-bottom:2px}
.hp-hero-v{font-size:clamp(34px,5vw,52px);font-weight:800;line-height:1.04;letter-spacing:-.03em;color:var(--hp-up);font-variant-numeric:tabular-nums}
.hp-hero-sub{font-size:12.5px;color:var(--hp-fg-2);margin-top:7px}
.hp-hero-side{display:grid;grid-template-columns:repeat(3,minmax(96px,1fr));gap:10px;flex:0 1 auto}
.hp-stat-card{border:var(--hp-border);border-radius:11px;padding:10px 13px;background:var(--hp-surface);box-shadow:var(--hp-shadow);min-width:96px;display:flex;flex-direction:column;justify-content:center}
.hp-stat-k{font-size:10.5px;color:var(--hp-fg-3);margin-bottom:3px;white-space:nowrap}
.hp-stat-v{font-size:17px;font-weight:750;font-variant-numeric:tabular-nums;letter-spacing:-.02em}
/* 纸感主题：三张统计卡上色，像便签 */
.hp-root.hp-paper .hp-stat-card.rose{background:#ffb9cc}
.hp-root.hp-paper .hp-stat-card.sky{background:#a5dcff}
.hp-root.hp-paper .hp-stat-card.sun{background:#ffd84d}
.hp-root.hp-paper .hp-hero-main{background:var(--hp-card)}

.hp-cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(340px,1fr));gap:12px;padding:16px 20px 28px}
.hp-card{position:relative;border:var(--hp-border);border-radius:var(--hp-radius);padding:13px 15px 11px;display:flex;flex-direction:column;background:var(--hp-card-bg);box-shadow:var(--hp-shadow);cursor:pointer;transition:transform .14s ease,box-shadow .14s,border-color .14s;overflow:hidden}
.hp-card:hover{transform:translateY(-2px);box-shadow:var(--hp-shadow-hover)}
.hp-root.hp-dark .hp-card:hover{border-color:rgba(122,92,255,.5)}
.hp-card.sel{box-shadow:0 0 0 2px var(--hp-accent),var(--hp-shadow-hover)}
.hp-card.top1{background:linear-gradient(135deg,rgba(217,165,43,.13),var(--hp-card-bg) 55%)}
.hp-card.top2{background:linear-gradient(135deg,rgba(154,164,178,.12),var(--hp-card-bg) 55%)}
.hp-card.top3{background:linear-gradient(135deg,rgba(192,122,62,.13),var(--hp-card-bg) 55%)}
/* 纸感主题下前三名用实色贴纸，而不是渐变 */
.hp-root.hp-paper .hp-card.top1{background:linear-gradient(135deg,#fff6d6,#fffdf7 60%)}
.hp-root.hp-paper .hp-card.top2{background:linear-gradient(135deg,#f3f1ec,#fffdf7 60%)}
.hp-root.hp-paper .hp-card.top3{background:linear-gradient(135deg,#ffeadb,#fffdf7 60%)}
.hp-card-head{display:flex;align-items:flex-start;gap:11px}
.hp-rank{flex:0 0 auto;width:30px;height:30px;border-radius:9px;display:flex;align-items:center;justify-content:center;font-size:13px;font-weight:700;font-variant-numeric:tabular-nums;background:var(--hp-surface-2);color:var(--hp-fg-2)}
.hp-root.hp-paper .hp-rank{border:2px solid var(--hp-ink);box-shadow:2px 2px 0 var(--hp-ink)}
.hp-rank.r1{background:linear-gradient(135deg,#e8b53a,#c9901f);color:#2a1c00;box-shadow:0 2px 10px rgba(217,165,43,.45)}
.hp-rank.r2{background:linear-gradient(135deg,#c8d0da,#95a0ad);color:#1d242c}
.hp-rank.r3{background:linear-gradient(135deg,#d4945a,#a9652f);color:#2a1400}
.hp-title{flex:1;min-width:0}
.hp-name{font-size:14.5px;font-weight:650;letter-spacing:.1px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.hp-name .owner{color:var(--hp-fg-3);font-weight:450}
.hp-sub{font-size:11.5px;color:var(--hp-fg-3);margin-top:3px;display:flex;gap:8px;flex-wrap:wrap;align-items:center}
.hp-chip{font-size:10.5px;padding:1px 7px;border-radius:999px;background:var(--hp-surface-2);color:var(--hp-fg-2);white-space:nowrap}
.hp-root.hp-paper .hp-chip{border:1.5px solid var(--hp-ink);background:#fff;font-weight:600}
.hp-root.hp-paper .hp-chip.pct{background:var(--hp-gold)}
.hp-root.hp-paper .hp-chip.lic{background:#a5dcff}
.hp-gain{text-align:right;font-variant-numeric:tabular-nums;flex:0 0 auto;padding-left:6px}
.hp-gain-v{font-size:21px;font-weight:780;line-height:1.05;letter-spacing:-.5px}
.hp-gain-v.up{color:var(--hp-up)}
.hp-root.hp-dark .hp-gain-v.up{text-shadow:0 0 18px rgba(229,72,77,.35)}
.hp-gain-v.flat{color:var(--hp-fg-2)}
.hp-gain-s{font-size:10.5px;color:var(--hp-fg-3);margin-top:2px}
/* 简介：取不到就整块不渲染，所以这里**不设 min-height**，避免空灰色占位 */
.hp-desc{margin:9px 0 0;font-size:12.5px;line-height:1.6;color:var(--hp-fg-2);display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.hp-desc-loading{margin-top:10px;display:flex;flex-direction:column;gap:5px}
.hp-desc-loading i{display:block;height:8px;border-radius:4px;background:linear-gradient(100deg,var(--hp-surface-2) 30%,var(--hp-sep) 50%,var(--hp-surface-2) 70%);background-size:220% 100%;animation:hp-shimmer 1.4s infinite linear}
.hp-desc-loading i:last-child{width:62%}
/* 卡片底部：右下角迷你走势 */
.hp-card-foot{display:flex;justify-content:flex-end;margin-top:6px;margin-bottom:-2px}
.hp-spark{width:132px;height:34px;opacity:.85;transition:opacity .16s}
.hp-card:hover .hp-spark{opacity:1}
.hp-card-loading{height:120px;border-radius:var(--hp-radius);border:var(--hp-border);background:linear-gradient(100deg,var(--hp-surface) 30%,var(--hp-surface-2) 50%,var(--hp-surface) 70%);background-size:220% 100%;animation:hp-shimmer 1.5s infinite linear}
@keyframes hp-shimmer{0%{background-position:130% 0}100%{background-position:-30% 0}}
.hp-more{display:flex;justify-content:center;padding:0 20px 30px}

/* ---------- 详情面板 ---------- */
.hp-detail{margin:16px 20px 28px;border:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.09));border-radius:15px;background:var(--dsw-alias-bg-layer-2,rgba(255,255,255,.035));overflow:hidden}
.hp-detail-head{display:flex;align-items:center;gap:12px;padding:15px 18px;border-bottom:1px solid var(--dsw-alias-separator-primary,rgba(255,255,255,.07))}
.hp-detail-head .hp-name{font-size:16px}
.hp-close{margin-left:auto;border:0;background:transparent;color:var(--dsw-alias-label-tertiary,rgba(255,255,255,.5));font-size:19px;cursor:pointer;line-height:1;padding:4px 7px;border-radius:7px}
.hp-close:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.08));color:#fff}
.hp-detail-body{display:grid;grid-template-columns:minmax(0,1.15fr) minmax(240px,.85fr);gap:0}
@media (max-width:820px){.hp-detail-body{grid-template-columns:1fr}}
.hp-pane{padding:16px 18px}
.hp-pane + .hp-pane{border-left:1px solid var(--dsw-alias-separator-primary,rgba(255,255,255,.07))}
@media (max-width:820px){.hp-pane + .hp-pane{border-left:0;border-top:1px solid var(--dsw-alias-separator-primary,rgba(255,255,255,.07))}}
.hp-pane-title{font-size:11px;font-weight:650;letter-spacing:.09em;text-transform:uppercase;color:var(--dsw-alias-label-tertiary,rgba(255,255,255,.42));margin-bottom:9px;display:flex;align-items:center;gap:7px}
.hp-pane-title::after{content:'';flex:1;height:1px;background:var(--dsw-alias-separator-primary,rgba(255,255,255,.07))}
.hp-intro{font-size:13px;line-height:1.68;color:var(--dsw-alias-label-secondary,rgba(255,255,255,.78))}
.hp-intro.none{color:var(--dsw-alias-label-tertiary,rgba(255,255,255,.4));font-style:italic}
.hp-srcline{font-size:11px;margin-top:9px;line-height:1.5;color:var(--hp-fg-3)}
.hp-srcline a{color:inherit;text-decoration:none;border-bottom:1px dotted currentColor}
.hp-srcline a:hover{color:var(--hp-fg)}
.hp-kpis{display:grid;grid-template-columns:repeat(3,1fr);gap:9px;margin-top:14px}
.hp-kpi{border:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.07));border-radius:9px;padding:8px 10px;background:var(--dsw-alias-bg-layer-1,rgba(0,0,0,.18))}
.hp-kpi-k{font-size:10.5px;color:var(--dsw-alias-label-tertiary,rgba(255,255,255,.4));margin-bottom:3px}
.hp-kpi-v{font-size:15px;font-weight:700;font-variant-numeric:tabular-nums}
.hp-kpi-v.up{color:var(--hp-up)}
.hp-links{display:flex;gap:8px;flex-wrap:wrap;margin-top:13px}
.hp-link{font-size:12px;padding:5px 11px;border-radius:7px;border:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.12));color:var(--dsw-alias-label-secondary,rgba(255,255,255,.72));text-decoration:none;transition:all .15s}
.hp-link:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.08));color:#fff}

/* ---------- 趋势图 ---------- */
.hp-chart{width:100%;height:auto;display:block;overflow:visible}
.hp-chart-wrap{position:relative;margin-top:2px}
.hp-chart-empty{font-size:12px;color:var(--dsw-alias-label-tertiary,rgba(255,255,255,.4));padding:22px 0;text-align:center;font-style:italic}
.hp-chart-legend{display:flex;justify-content:space-between;font-size:11px;color:var(--dsw-alias-label-tertiary,rgba(255,255,255,.45));font-variant-numeric:tabular-nums;margin-top:5px}

/* ---------- 头像 ---------- */
.hp-avatar{flex:0 0 auto;border-radius:9px;object-fit:cover;background:var(--hp-surface-2);display:block}
.hp-root.hp-paper .hp-avatar{border:2px solid var(--hp-ink)}
.hp-avatar-fb{display:inline-flex;align-items:center;justify-content:center;color:#fff;font-weight:700;border-radius:9px;flex:0 0 auto;user-select:none}

/* ---------- 右侧操作区 ---------- */
.hp-actions{display:flex;align-items:center;gap:8px;flex-wrap:nowrap;flex:0 0 auto;margin-left:auto}
.hp-head .hp-meta{flex:1 1 auto;min-width:0;justify-content:flex-end;overflow:hidden;white-space:nowrap}
/* ---------- 简介：中文优先 ---------- */
.hp-zh-pending{display:inline-block;margin-left:6px;font-size:10px;padding:0 4px;border-radius:4px;background:var(--hp-surface-2);color:var(--hp-fg-3);vertical-align:middle}
.hp-desc.zh{font-family:var(--dsw-font,-apple-system,'PingFang SC','Microsoft YaHei',sans-serif);letter-spacing:.01em;line-height:1.65}
.hp-intro.zh{font-size:13.5px;line-height:1.75;color:var(--hp-fg)}
.hp-intro-en{font-size:12px;line-height:1.65;color:var(--hp-fg-3);margin-top:10px;padding-top:9px;border-top:1px dashed var(--hp-sep)}

/* ---------- 首屏主角（先给答案）---------- */
.hp-hero{display:flex;gap:18px;align-items:stretch;padding:18px 20px 6px;flex-wrap:wrap}
.hp-hero-main{flex:1 1 320px;min-width:260px;border:var(--hp-border);border-radius:var(--hp-radius);background:var(--hp-card-bg);box-shadow:var(--hp-shadow);padding:16px 20px 15px}
.hp-hero-k{font-size:11.5px;font-weight:600;letter-spacing:.06em;color:var(--hp-fg-3);margin-bottom:2px}
.hp-hero-v{font-size:clamp(34px,5vw,52px);font-weight:800;line-height:1.04;letter-spacing:-.03em;color:var(--hp-up);font-variant-numeric:tabular-nums}
.hp-hero-sub{font-size:12.5px;color:var(--hp-fg-2);margin-top:7px}
.hp-hero-side{display:grid;grid-template-columns:repeat(3,minmax(96px,1fr));gap:10px;flex:0 1 auto}
.hp-stat-card{border:var(--hp-border);border-radius:11px;padding:10px 13px;background:var(--hp-surface);box-shadow:var(--hp-shadow);min-width:96px;display:flex;flex-direction:column;justify-content:center}
.hp-stat-k{font-size:10.5px;color:var(--hp-fg-3);margin-bottom:3px;white-space:nowrap}
.hp-stat-v{font-size:17px;font-weight:750;font-variant-numeric:tabular-nums;letter-spacing:-.02em}
/* 纸感主题：三张统计卡上色，像便签 */
.hp-root.hp-paper .hp-stat-card.rose{background:#ffb9cc}
.hp-root.hp-paper .hp-stat-card.sky{background:#a5dcff}
.hp-root.hp-paper .hp-stat-card.sun{background:#ffd84d}
.hp-root.hp-paper .hp-hero-main{background:var(--hp-card)}

.hp-cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(340px,1fr));gap:12px;padding:16px 20px 28px}
.hp-card{position:relative;border:var(--hp-border);border-radius:var(--hp-radius);padding:13px 15px 11px;display:flex;flex-direction:column;background:var(--hp-card-bg);box-shadow:var(--hp-shadow);cursor:pointer;transition:transform .14s ease,box-shadow .14s,border-color .14s;overflow:hidden}
.hp-card:hover{transform:translateY(-2px);box-shadow:var(--hp-shadow-hover)}
.hp-root.hp-dark .hp-card:hover{border-color:rgba(122,92,255,.5)}
.hp-card.sel{box-shadow:0 0 0 2px var(--hp-accent),var(--hp-shadow-hover)}
.hp-card.top1{background:linear-gradient(135deg,rgba(217,165,43,.13),var(--hp-card-bg) 55%)}
.hp-card.top2{background:linear-gradient(135deg,rgba(154,164,178,.12),var(--hp-card-bg) 55%)}
.hp-card.top3{background:linear-gradient(135deg,rgba(192,122,62,.13),var(--hp-card-bg) 55%)}
/* 纸感主题下前三名用实色贴纸，而不是渐变 */
.hp-root.hp-paper .hp-card.top1{background:linear-gradient(135deg,#fff6d6,#fffdf7 60%)}
.hp-root.hp-paper .hp-card.top2{background:linear-gradient(135deg,#f3f1ec,#fffdf7 60%)}
.hp-root.hp-paper .hp-card.top3{background:linear-gradient(135deg,#ffeadb,#fffdf7 60%)}
.hp-card-head{display:flex;align-items:flex-start;gap:11px}
.hp-rank{flex:0 0 auto;width:30px;height:30px;border-radius:9px;display:flex;align-items:center;justify-content:center;font-size:13px;font-weight:700;font-variant-numeric:tabular-nums;background:var(--hp-surface-2);color:var(--hp-fg-2)}
.hp-root.hp-paper .hp-rank{border:2px solid var(--hp-ink);box-shadow:2px 2px 0 var(--hp-ink)}
.hp-rank.r1{background:linear-gradient(135deg,#e8b53a,#c9901f);color:#2a1c00;box-shadow:0 2px 10px rgba(217,165,43,.45)}
.hp-rank.r2{background:linear-gradient(135deg,#c8d0da,#95a0ad);color:#1d242c}
.hp-rank.r3{background:linear-gradient(135deg,#d4945a,#a9652f);color:#2a1400}
.hp-title{flex:1;min-width:0}
.hp-name{font-size:14.5px;font-weight:650;letter-spacing:.1px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.hp-name .owner{color:var(--hp-fg-3);font-weight:450}
.hp-sub{font-size:11.5px;color:var(--hp-fg-3);margin-top:3px;display:flex;gap:8px;flex-wrap:wrap;align-items:center}
.hp-chip{font-size:10.5px;padding:1px 7px;border-radius:999px;background:var(--hp-surface-2);color:var(--hp-fg-2);white-space:nowrap}
.hp-root.hp-paper .hp-chip{border:1.5px solid var(--hp-ink);background:#fff;font-weight:600}
.hp-root.hp-paper .hp-chip.pct{background:var(--hp-gold)}
.hp-root.hp-paper .hp-chip.lic{background:#a5dcff}
.hp-gain{text-align:right;font-variant-numeric:tabular-nums;flex:0 0 auto;padding-left:6px}
.hp-gain-v{font-size:21px;font-weight:780;line-height:1.05;letter-spacing:-.5px}
.hp-gain-v.up{color:var(--hp-up)}
.hp-root.hp-dark .hp-gain-v.up{text-shadow:0 0 18px rgba(229,72,77,.35)}
.hp-gain-v.flat{color:var(--hp-fg-2)}
.hp-gain-s{font-size:10.5px;color:var(--hp-fg-3);margin-top:2px}
/* 简介：取不到就整块不渲染，所以这里**不设 min-height**，避免空灰色占位 */
.hp-desc{margin:9px 0 0;font-size:12.5px;line-height:1.6;color:var(--hp-fg-2);display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.hp-desc-loading{margin-top:10px;display:flex;flex-direction:column;gap:5px}
.hp-desc-loading i{display:block;height:8px;border-radius:4px;background:linear-gradient(100deg,var(--hp-surface-2) 30%,var(--hp-sep) 50%,var(--hp-surface-2) 70%);background-size:220% 100%;animation:hp-shimmer 1.4s infinite linear}
.hp-desc-loading i:last-child{width:62%}
/* 卡片底部：右下角迷你走势 */
.hp-card-foot{display:flex;justify-content:flex-end;margin-top:6px;margin-bottom:-2px}
.hp-spark{width:132px;height:34px;opacity:.85;transition:opacity .16s}
.hp-card:hover .hp-spark{opacity:1}
.hp-card-loading{height:120px;border-radius:var(--hp-radius);border:var(--hp-border);background:linear-gradient(100deg,var(--hp-surface) 30%,var(--hp-surface-2) 50%,var(--hp-surface) 70%);background-size:220% 100%;animation:hp-shimmer 1.5s infinite linear}
@keyframes hp-shimmer{0%{background-position:130% 0}100%{background-position:-30% 0}}
.hp-more{display:flex;justify-content:center;padding:0 20px 30px}

/* ---------- 详情面板 ---------- */
.hp-detail{margin:16px 20px 28px;border:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.09));border-radius:15px;background:var(--dsw-alias-bg-layer-2,rgba(255,255,255,.035));overflow:hidden}
.hp-detail-head{display:flex;align-items:center;gap:12px;padding:15px 18px;border-bottom:1px solid var(--dsw-alias-separator-primary,rgba(255,255,255,.07))}
.hp-detail-head .hp-name{font-size:16px}
.hp-close{margin-left:auto;border:0;background:transparent;color:var(--dsw-alias-label-tertiary,rgba(255,255,255,.5));font-size:19px;cursor:pointer;line-height:1;padding:4px 7px;border-radius:7px}
.hp-close:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.08));color:#fff}
.hp-detail-body{display:grid;grid-template-columns:minmax(0,1.15fr) minmax(240px,.85fr);gap:0}
@media (max-width:820px){.hp-detail-body{grid-template-columns:1fr}}
.hp-pane{padding:16px 18px}
.hp-pane + .hp-pane{border-left:1px solid var(--dsw-alias-separator-primary,rgba(255,255,255,.07))}
@media (max-width:820px){.hp-pane + .hp-pane{border-left:0;border-top:1px solid var(--dsw-alias-separator-primary,rgba(255,255,255,.07))}}
.hp-pane-title{font-size:11px;font-weight:650;letter-spacing:.09em;text-transform:uppercase;color:var(--dsw-alias-label-tertiary,rgba(255,255,255,.42));margin-bottom:9px;display:flex;align-items:center;gap:7px}
.hp-pane-title::after{content:'';flex:1;height:1px;background:var(--dsw-alias-separator-primary,rgba(255,255,255,.07))}
.hp-intro{font-size:13px;line-height:1.68;color:var(--dsw-alias-label-secondary,rgba(255,255,255,.78))}
.hp-intro.none{color:var(--dsw-alias-label-tertiary,rgba(255,255,255,.4));font-style:italic}
.hp-srcline{font-size:11px;margin-top:9px;line-height:1.5;color:var(--hp-fg-3)}
.hp-srcline a{color:inherit;text-decoration:none;border-bottom:1px dotted currentColor}
.hp-srcline a:hover{color:var(--hp-fg)}
.hp-kpis{display:grid;grid-template-columns:repeat(3,1fr);gap:9px;margin-top:14px}
.hp-kpi{border:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.07));border-radius:9px;padding:8px 10px;background:var(--dsw-alias-bg-layer-1,rgba(0,0,0,.18))}
.hp-kpi-k{font-size:10.5px;color:var(--dsw-alias-label-tertiary,rgba(255,255,255,.4));margin-bottom:3px}
.hp-kpi-v{font-size:15px;font-weight:700;font-variant-numeric:tabular-nums}
.hp-kpi-v.up{color:var(--hp-up)}
.hp-links{display:flex;gap:8px;flex-wrap:wrap;margin-top:13px}
.hp-link{font-size:12px;padding:5px 11px;border-radius:7px;border:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.12));color:var(--dsw-alias-label-secondary,rgba(255,255,255,.72));text-decoration:none;transition:all .15s}
.hp-link:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.08));color:#fff}

/* ---------- 趋势图 ---------- */
.hp-chart{width:100%;height:auto;display:block;overflow:visible}
.hp-chart-wrap{position:relative;margin-top:2px}
.hp-chart-empty{font-size:12px;color:var(--dsw-alias-label-tertiary,rgba(255,255,255,.4));padding:22px 0;text-align:center;font-style:italic}
.hp-chart-legend{display:flex;justify-content:space-between;font-size:11px;color:var(--dsw-alias-label-tertiary,rgba(255,255,255,.45));font-variant-numeric:tabular-nums;margin-top:5px}

`;
    doc.head.appendChild(style);
  }

  /* ============================================================ 图表组件 */

  /**
   * 把一串点连成**平滑曲线**（Catmull-Rom 转三次贝塞尔）。
   *
   * 为什么不用折线：星数快照之间是每天一个点，直连会是一串生硬的折角，
   * 看不出「加速 / 放缓」的趋势形状。平滑后曲线读起来更像行情图。
   *
   * 注意：平滑只是**画法**，不改变数据点位置 —— 点仍然落在原坐标上。
   */
  function smoothPath(points) {
    if (!points || points.length === 0) return '';
    if (points.length === 1) return 'M' + points[0][0] + ' ' + points[0][1];
    if (points.length === 2) return 'M' + points[0][0] + ' ' + points[0][1] + ' L' + points[1][0] + ' ' + points[1][1];
    let d = 'M' + points[0][0] + ' ' + points[0][1];
    for (let i = 0; i < points.length - 1; i += 1) {
      const p0 = points[i - 1] || points[i];
      const p1 = points[i];
      const p2 = points[i + 1];
      const p3 = points[i + 2] || p2;
      // 控制点系数 1/6 是 Catmull-Rom → 贝塞尔的经典换算
      const c1x = p1[0] + (p2[0] - p0[0]) / 6;
      const c1y = p1[1] + (p2[1] - p0[1]) / 6;
      const c2x = p2[0] - (p3[0] - p1[0]) / 6;
      const c2y = p2[1] - (p3[1] - p1[1]) / 6;
      d += ' C' + c1x.toFixed(1) + ' ' + c1y.toFixed(1) +
           ' ' + c2x.toFixed(1) + ' ' + c2y.toFixed(1) +
           ' ' + p2[0] + ' ' + p2[1];
    }
    return d;
  }

  /**
   * 股票式星数曲线：带面积填充、端点标记、起止标注。
   *
   * 注意：这是**组件**，必须用 `h(StarChart, { chart })` 渲染，
   * 不能直接调用 —— 直接调用返回的 React 元素会被当成普通对象塞进子节点而报错。
   */
  function StarChart(props) {
    const { React, chart } = props;
    const h = React.createElement;
    if (!chart || !Array.isArray(chart.series) || chart.series.length < 3) {
      return h('div', { className: 'hp-chart-empty' }, '暂无星数曲线数据');
    }
    const W = 560;
    const H = 190;
    const PAD = { l: 8, r: 8, t: 12, b: 24 };
    const series = chart.series;
    const xs = series.map((p) => p.x);
    const ys = series.map((p) => p.stars);
    const xmin = Math.min(...xs);
    const xmax = Math.max(...xs);
    const ymin = Math.min(...ys);
    const ymax = Math.max(...ys);
    const spanX = xmax - xmin || 1;
    const spanY = ymax - ymin || 1;
    const px = (x) => PAD.l + ((x - xmin) / spanX) * (W - PAD.l - PAD.r);
    const py = (v) => H - PAD.b - ((v - ymin) / spanY) * (H - PAD.t - PAD.b);

    const line = series.map((p, i) => (i === 0 ? 'M' : 'L') + px(p.x).toFixed(1) + ' ' + py(p.stars).toFixed(1)).join(' ');
    const area = line + ' L' + px(xmax).toFixed(1) + ' ' + (H - PAD.b) + ' L' + px(xmin).toFixed(1) + ' ' + (H - PAD.b) + ' Z';

    const first = ys[0];
    const last = ys[ys.length - 1];
    const gained = last - first;
    const label = (p) => (p && p.label ? p.label : '');

    return h(
      'div',
      { className: 'hp-chart-wrap' },
      h(
        'svg',
        { className: 'hp-chart', viewBox: '0 0 ' + W + ' ' + H, preserveAspectRatio: 'xMidYMid meet', role: 'img' },
        h(
          'defs',
          null,
          h(
            'linearGradient',
            { id: 'hp-area-grad', x1: '0', y1: '0', x2: '0', y2: '1' },
            h('stop', { offset: '0%', stopColor: '#e5484d', stopOpacity: '0.42' }),
            h('stop', { offset: '100%', stopColor: '#e5484d', stopOpacity: '0.02' }),
          ),
        ),
        // 水平网格
        [0, 0.25, 0.5, 0.75, 1].map((t, i) => {
          const y = (H - PAD.b) - t * (H - PAD.t - PAD.b);
          const v = ymin + t * spanY;
          return h(
            'g',
            { key: 'g' + i },
            h('line', { x1: PAD.l, x2: W - PAD.r, y1: y, y2: y, stroke: 'rgba(255,255,255,.07)', strokeDasharray: '3 4' }),
            h('text', { x: W - PAD.r, y: y - 3, textAnchor: 'end', fontSize: '9.5', fill: 'rgba(255,255,255,.32)' }, fmtCount(v)),
          );
        }),
        // 面积 + 曲线
        h('path', { d: area, fill: 'url(#hp-area-grad)' }),
        h('path', { d: line, fill: 'none', stroke: '#e5484d', strokeWidth: '2', strokeLinejoin: 'round', strokeLinecap: 'round' }),
        // 端点
        h('circle', { cx: px(xs[0]), cy: py(first), r: '3.2', fill: '#e5484d' }),
        h('circle', { cx: px(xmax), cy: py(last), r: '4', fill: '#e5484d', stroke: '#fff', strokeWidth: '1.4' }),
        // x 轴标签
        (chart.xLabels || []).map((lab, i) =>
          h('text', { key: 'x' + i, x: px(lab.x), y: H - 7, textAnchor: 'middle', fontSize: '9.5', fill: 'rgba(255,255,255,.32)' }, label(lab)),
        ),
      ),
      h(
        'div',
        { className: 'hp-chart-legend' },
        h('span', null, '起点 ' + fmtCount(first)),
        h('span', { style: { color: '#ff8a90', fontWeight: 650 } }, '+' + fmtCount(gained) + ' ★'),
        h('span', null, '现在 ' + fmtCount(last)),
      ),
    );
  }

  /* ============================================================ 卡片 */

  /**
   * 仓库所有者头像。
   *
   * 走宿主代理接口（/avatar），不是直连 github.com —— 一张卡一次外网请求太快烧钱了。
   * 取不到时退化成「首字母块」，与 GitHub 自己的降级行为一致，不会出现破图标。
   */
  function Avatar(props) {
    const { React, repository, size } = props;
    const h = React.createElement;
    const owner = String(repository || '').split('/')[0] || '?';
    const px = size || 34;
    const [failed, setFailed] = React.useState(false);
    const initial = owner.replace(/^[^a-zA-Z0-9]/, '').slice(0, 1).toUpperCase() || '?';
    // 用固定色相区分不同 owner，避免整屏同色
    let hue = 0;
    for (let i = 0; i < owner.length; i += 1) hue = (hue * 31 + owner.charCodeAt(i)) % 360;
    if (failed) {
      return h(
        'span',
        {
          className: 'hp-avatar hp-avatar-fb',
          style: { width: px, height: px, background: 'hsl(' + hue + ' 45% 38%)', fontSize: Math.round(px * 0.42) },
          title: owner,
        },
        initial,
      );
    }
    // 优先用 /batch 里内联的 data URI（不发额外请求）；
    // 没有才退回 /avatar 接口（每个项目一个请求，只在详情页等少数场景发生）。
    const inline = props.src || null;
    return h('img', {
      className: 'hp-avatar',
      src: inline || BASE + '/avatar?repo=' + encodeURIComponent(repository || owner),
      width: px,
      height: px,
      alt: owner,
      loading: 'lazy',
      onError: () => setFailed(true),
    });
  }

  /**
   * 迷你走势：卡片右下角的一小段星数曲线。
   * 没有曲线数据时**什么都不画** —— 绝不画一条假的水平线充数。
   */
  function Sparkline(props) {
    const { React, chart, tone } = props;
    const h = React.createElement;
    if (!chart || !Array.isArray(chart.series) || chart.series.length < 3) return null;
    const W = 132;
    const H = 34;
    const ys = chart.series.map((p) => p.stars);
    const ymin = Math.min(...ys);
    const ymax = Math.max(...ys);
    const span = ymax - ymin || 1;
    const pts = chart.series.map((p, i) =>
      ((i / (chart.series.length - 1)) * W).toFixed(1) + ',' + (H - 2 - ((p.stars - ymin) / span) * (H - 6)).toFixed(1),
    );
    const color = tone === 'gold' ? '#e8b53a' : '#e5484d';
    return h(
      'svg',
      { className: 'hp-spark', viewBox: '0 0 ' + W + ' ' + H, preserveAspectRatio: 'none', 'aria-hidden': 'true' },
      h('polyline', { points: pts.join(' '), fill: 'none', stroke: color, strokeWidth: '1.6', strokeLinejoin: 'round', strokeLinecap: 'round', opacity: '0.9' }),
      h('circle', { cx: W, cy: (H - 2 - ((ys[ys.length - 1] - ymin) / span) * (H - 6)).toFixed(1), r: '2.4', fill: color }),
    );
  }

  /**
   * 一张成绩卡。
   *
   * 视觉重心刻意放在**涨星数**上（大号、涨色、带光晕），名次徽章与仓库名次之；
   * 简介只显示两行、取不到就**整块不渲染**（不留「暂无简介」那种灰色占位）；
   * 右下角用迷你走势代替进度条 —— 有曲线才画，没有就不占位。
   */
  function Card(props) {
    const { React } = props;
    const h = React.createElement;
    const { item, maxGain, isSel, onSelect, detail } = props;
    const isTop = item.rank <= 3;
    const cls = 'hp-card' + (isTop ? ' top' + item.rank : '') + (isSel ? ' sel' : '');
    const [owner, repo] = item.repository.split('/');
    const share = maxGain > 0 ? Math.round((item.starsGained / maxGain) * 100) : 0;
    /**
     * 简介显示策略（优先避免等待与空白）：
     *
     *   · 有译文       → 显示中文
     *   · 没译文但有英文 → **先显示英文**（不让用户对着骨架干等模型）
     *   · 什么都没有    → 骨架
     *
     * 之前选「中文」时会等译文、期间显示骨架，结果点了中文要等十几秒才出字 ——
     * 那个体验很差。现在英文秒到就先给内容，中文来了原地替换。
     * 英文模式下也一样，只是不再触发翻译。
     */
    const descZh = detail && detail.descZh ? detail.descZh : null;
    const descEn = detail && detail.desc ? detail.desc : null;
    const lang = props.lang === 'en' ? 'en' : 'zh';
    /**
     * 严格按语言选：英文模式就显示英文（哪怕库里还留着中文译文），
     * 中文模式优先中文、没译文时先用英文顶着。
     * 之前写成 `descZh || descEn`，结果英文模式下也会显示中文 —— 与按钮状态矛盾。
     */
    const desc = lang === 'en' ? descEn || descZh : descZh || descEn;
    // 中文模式下有英文但还没译文 → 标记「翻译中」，界面上给个小提示
    const translating = lang === 'zh' && !descZh && !!descEn;
    return h(
      'article',
      {
        className: cls,
        onClick: () => onSelect(item),
        onKeyDown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelect(item); } },
        role: 'button',
        tabIndex: 0,
        title: item.repository + (desc ? '\n' + desc : ''),
      },
      // ── 顶部：名次 + 仓库名 + 涨星 ──
      h(
        'div',
        { className: 'hp-card-head' },
        h(Avatar, { React, repository: item.repository, size: isTop ? 40 : 34, src: detail && detail.avatar }),
        h('div', { className: 'hp-rank' + (isTop ? ' r' + item.rank : '') }, item.rank),
        h(
          'div',
          { className: 'hp-title' },
          h('div', { className: 'hp-name' }, h('span', { className: 'owner' }, owner + '/'), repo),
          h(
            'div',
            { className: 'hp-sub' },
            item.language ? h('span', { className: 'hp-chip' }, item.language) : null,
            item.growthPct !== null ? h('span', { className: 'hp-chip pct' }, fmtPct(item.growthPct)) : null,
            item.license ? h('span', { className: 'hp-chip lic' }, item.license) : null,
          ),
        ),
        h(
          'div',
          { className: 'hp-gain' },
          h('div', { className: 'hp-gain-v ' + gainTone(item.starsGained) }, '+' + fmtCount(item.starsGained)),
          h('div', { className: 'hp-gain-s' }, share >= 60 ? '本期最猛' : item.endStars ? fmtCount(item.endStars) + ' stars' : ''),
        ),
      ),
      // ── 简介：有才渲染 ──
      desc
        ? h('p', { className: 'hp-desc' + (descZh ? ' zh' : '') }, desc,
            translating ? h('span', { className: 'hp-zh-pending', title: '中文翻译生成中' }, ' 译') : null)
        : // 还没取完：骨架；取完了却什么都没有（没有该项目分析）：留空不占位
          detail && detail.settled
          ? null
          : h('div', { className: 'hp-desc-loading' }, h('i'), h('i')),
      // ── 底部：迷你走势 ──
      detail && detail.chart
        ? h('div', { className: 'hp-card-foot' }, h(Sparkline, { React, chart: detail.chart, tone: isTop ? 'gold' : 'red' }))
        : null,
    );
  }

  /* ============================================================ 详情视图 */

  function Detail(props) {
    const { React } = props;
    const h = React.createElement;
    const { item, detail, loading, error, onClose } = props;
    if (!item) return null;
    const [owner, repo] = item.repository.split('/');
    const d = detail || {};
    return h(
      'div',
      { className: 'hp-detail' },
      h(
        'div',
        { className: 'hp-detail-head' },
        h(Avatar, { React, repository: item.repository, size: 40 }),
        h('div', { className: 'hp-rank' + (item.rank <= 3 ? ' r' + item.rank : '') }, item.rank),
        h(
          'div',
          { className: 'hp-title' },
          h('div', { className: 'hp-name' }, h('span', { className: 'owner' }, owner + ' / '), repo),
          h(
            'div',
            { className: 'hp-sub' },
            item.language ? h('span', { className: 'hp-chip' }, item.language) : null,
            item.license ? h('span', { className: 'hp-chip' }, item.license) : null,
            d.analysisUpdated ? h('span', { style: { opacity: 0.7 } }, '分析更新于 ' + d.analysisUpdated) : null,
          ),
        ),
        h('div', { className: 'hp-gain', style: { marginLeft: 'auto' } },
          h('div', { className: 'hp-gain-v ' + gainTone(item.starsGained) }, '+' + fmtCount(item.starsGained)),
          h('div', { className: 'hp-gain-s' }, item.endStars ? fmtCount(item.endStars) + ' 星' : ''),
        ),
        h('button', { className: 'hp-close', onClick: onClose, title: '关闭' }, '×'),
      ),
      h(
        'div',
        { className: 'hp-detail-body' },
        // 左：简介
        h(
          'div',
          { className: 'hp-pane' },
          h('div', { className: 'hp-pane-title' }, '项目简介'),
          loading
            ? h('div', { className: 'hp-intro none' }, '正在读取并翻译中…')
            : h(
                'div',
                null,
                d.descZh
                  ? h('div', { className: 'hp-intro zh' }, d.descZh)
                  : null,
                d.desc
                  ? h(
                      'div',
                      { className: d.descZh ? 'hp-intro-en' : 'hp-intro' },
                      d.desc,
                    )
                  : h('div', { className: 'hp-intro none' }, error ? '读取失败：' + error : '暂无简介'),
              ),
          /**
           * 简介的来源说明。
           *
           * 合规要点：这段文字是转载的第三方分析（CC BY 4.0），必须让读者知道
           * 它不是本项目原创。所以明确写出「引用自 Hysen Labs」并带上链接，
           * 同时说明中译是谁做的、原文在哪。
           */
          d.descSource === 'conclusion' || d.descSource === 'overview'
            ? h(
                'div',
                { className: 'hp-srcline' },
                h('span', null, d.descSource === 'conclusion' ? '编辑结论' : '项目概览'),
                ' · 引用自 ',
                h('a', { href: item.hysenUrl || 'https://hysenlabs.com', target: '_blank', rel: 'noreferrer' }, 'Hysen Labs'),
                '（CC BY 4.0）',
                d.descZh ? ' · 中译由 DSH 模型生成，英文原文见下方' : '',
              )
            : null,
          h(
            'div',
            { className: 'hp-kpis' },
            h('div', { className: 'hp-kpi' }, h('div', { className: 'hp-kpi-k' }, '期间涨星'), h('div', { className: 'hp-kpi-v up' }, '+' + fmtCount(item.starsGained))),
            h('div', { className: 'hp-kpi' }, h('div', { className: 'hp-kpi-k' }, '起点星数'), h('div', { className: 'hp-kpi-v' }, fmtCount(item.startStars))),
            h('div', { className: 'hp-kpi' }, h('div', { className: 'hp-kpi-k' }, '最新星数'), h('div', { className: 'hp-kpi-v' }, fmtCount(item.endStars))),
          ),
          h(
            'div',
            { className: 'hp-links' },
            h('a', { className: 'hp-link', href: item.githubUrl, target: '_blank', rel: 'noreferrer' }, '↗ GitHub'),
            // 数据源详情页外链：直接标出站点名，用户一眼知道点过去是什么
            item.hysenUrl
              ? h('a', { className: 'hp-link', href: item.hysenUrl, target: '_blank', rel: 'noreferrer' }, '↗ hysenlabs')
              : null,
          ),
        ),
        // 右：曲线
        h(
          'div',
          { className: 'hp-pane' },
          h('div', { className: 'hp-pane-title' }, '星数曲线'),
          loading ? h('div', { className: 'hp-chart-empty' }, '加载中…') : h(StarChart, { React, chart: d.chart }),
          d.chartError && !d.chart ? h('div', { className: 'hp-chart-empty' }, '曲线读取失败：' + d.chartError) : null,
        ),
      ),
    );
  }

  /* ============================================================ 大盘视图 */

  /** 多曲线对比用的色板（8 条以内，之后循环）。 */
  const SERIES_COLORS = ['#3a6fe0', '#30a46c', '#e8b53a', '#e5484d', '#7b5cff', '#12a594', '#f76b15', '#8e4ec6'];

  /**
   * 统计视图 —— 多项目星数曲线对比（像看股票板块走势）。
   *
   * 左栏：勾选要看哪些项目（默认前 6 个），每项显示本期涨星；
   * 右栏：把选中项目的曲线**按真实日期对齐**后叠在同一张图上。
   *
   * 两个必须守住的点：
   *   1. **按日期对齐**，不是按点序号 —— 各项目起始日不同，按序号叠会错位。
   *   2. **两种量纲分开**：绝对星数（谁体量大）与本期涨幅（谁涨得猛）是两个问题，
   *      用分段器切换，不混在一张图里比。
   */
  function Dashboard(props) {
    const { React } = props;
    const h = React.createElement;
    const { rows, charts, lang, periodKey } = props;

    // 选项给全部（最多 20 条榜单），默认对比前 10 个 —— 再多线会糊成一团
    const [picked, setPicked] = React.useState(() => new Set((rows || []).slice(0, DEFAULT_COMPARE).map((r) => r.repository)));
    const [hover, setHover] = React.useState(null);

    // 数据换了一批（切榜单）时重置选择
    React.useEffect(() => {
      setPicked(new Set((rows || []).slice(0, DEFAULT_COMPARE).map((r) => r.repository)));
    }, [rows]);

    const toggle = (repo) => {
      setPicked((prev) => {
        const next = new Set(prev);
        if (next.has(repo)) next.delete(repo);
        else if (next.size < MAX_COMPARE) next.add(repo);
        return next;
      });
    };

    /** 取出选中项目的序列，并统一到全局时间轴。 */
    /**
     * 把选中项目的曲线整理成可对比的序列。
     *
     * 基准口径：
     *   1. 所有曲线用**同一天**当零点 —— 取所有选中项目里「最早出现的公共日期」。
     *      这样 9 月一起爆发和 8 月就起量的项目，是在同一条时间尺度上比。
     *   2. **不从 0 开始也没关系**：每条线从它自己第一次有数据那天开始画，
     *      中途才起来的项目就是坐标轴中间才冒出来的一条线，不需要从最左边硬接。
     *   3. 某个项目在基准日**还没有数据**时，用它最早那个点补齐起算
     *      （不做插值，不编数据；就是"它进榜那天"起算）。
     */
    const seriesList = React.useMemo(() => {
      const raw = [];
      for (const row of rows || []) {
        if (!picked.has(row.repository)) continue;
        const chart = charts && charts[row.repository];
        if (!chart || !Array.isArray(chart.series) || chart.series.length < 3) continue;
        const dated = chart.series.filter((p) => p && typeof p.date === 'string');
        if (dated.length < 3) continue;
        raw.push({ row, points: dated.slice().sort((a, b) => (a.date < b.date ? -1 : 1)) });
      }
      if (raw.length === 0) return [];

      // 基准日 = 所有曲线里「最晚的起始日」（保证每条线在这个日子上都有或即将有数据）
      // 与「最早的公共日」相比，取**最晚起始日**能让每条线都有完整的一段，
      // 不会出现某条线在基准日还没出生、导致整段缺口。
      let baseDate = raw[0].points[0].date;
      for (const series of raw) {
        const first = series.points[0].date;
        if (first > baseDate) baseDate = first;
      }

      return raw.map((series, idx) => {
        // 基准日之前没有数据的项目：用它的第一个点作为自己的起算点（不从 0 硬补）
        const startIdx = series.points.findIndex((p) => p.date >= baseDate);
        const from = startIdx >= 0 ? startIdx : 0;
        const baseStars = series.points[from].stars;
        return {
          repo: series.row.repository,
          color: SERIES_COLORS[idx % SERIES_COLORS.length],
          // 每条线只保留**基准日之后**的点；起点那天值记 0
          points: series.points.slice(from).map((p) => ({
            date: p.date,
            stars: p.stars,
            gained: p.stars - baseStars,
          })),
          baseDate: series.points[from].date,
          row: series.row,
        };
      });
    }, [rows, charts, picked]);

    /** 全局时间范围与量程。 */
    /**
     * 纵轴用**对数坐标**。
     *
     * 为什么：单条项目的涨幅可能比别人大一个量级（+425k vs +30k），线性坐标会把
     * 其余九条全压成贴着底边的一条线，完全看不出形状。对数下 1k→10k→100k 等距，
     * 大项目和小项目各自的走势都读得出来。
     *
     * 关键细节：涨幅可能从 0 开始，而 log(0) 无定义 —— 所以统一用 log(1 + 涨幅)，
     * 起点处正好是 0，不会出现 NaN。
     */
    const LOG_BASE = 1;
    const logV = (v) => Math.log10(Math.max(0, v) + LOG_BASE);
    const frame = React.useMemo(() => {
      if (seriesList.length === 0) return null;
      let minDate = Infinity;
      let maxDate = -Infinity;
      let minV = Infinity;
      let maxV = -Infinity;
      for (const s of seriesList) {
        for (const p of s.points) {
          const t = Date.parse(p.date);
          if (t < minDate) minDate = t;
          if (t > maxDate) maxDate = t;
          const v = p.gained;
          if (v < minV) minV = v;
          if (v > maxV) maxV = v;
        }
      }
      /**
       * 对数轴的可视范围。
       *
       * 关键：**下界不取 0**。所有曲线都从 0 出发会让十条线在最左边挤成一坨，
       * 而且下面那一大片空白完全是浪费。这里从「最小涨幅」再往下留半个数量级的余量，
       * 曲线就能撑满整个绘图区。
       *
       * 上界同理留一点余量，免得最高的那条贴顶被裁掉。
       */
      const loRaw = logV(minV);
      const hiRaw = logV(maxV);
      const pad = Math.max(0.12, (hiRaw - loRaw) * 0.06);
      const lo = loRaw - pad;
      const hi = hiRaw > loRaw ? hiRaw + pad : loRaw + 1;
      return { minDate, maxDate, minV, maxV, lo, hi };
    }, [seriesList]);

    const ready = rows && rows.length > 0;

    // ── 左栏：项目勾选列表 ──
    const picker = h(
      'aside',
      { className: 'hp-picker' },
      h('div', { className: 'hp-picker-title' }, '选择项目', h('span', { className: 'hp-picker-n' }, picked.size + ' / ' + MAX_COMPARE)),
      h(
        'div',
        { className: 'hp-picker-list' },
        (rows || []).map((row) => {
          const on = picked.has(row.repository);
          // charts 是 details[repo] = { desc, chart, ... }，曲线在 .chart.series
          const hasChart = charts && charts[row.repository] && Array.isArray(charts[row.repository].series);
          const color = seriesList.find((s) => s.repo === row.repository)?.color;
          return h(
            'label',
            { key: row.repository, className: 'hp-pick' + (on ? ' on' : '') + (hasChart ? '' : ' no-data') },
            h('input', {
              type: 'checkbox',
              checked: on,
              disabled: !hasChart,
              onChange: () => toggle(row.repository),
            }),
            h('span', { className: 'hp-pick-dot', style: color ? { background: color } : undefined }),
            h(Avatar, { React, repository: row.repository, size: 18 }),
            h('span', { className: 'hp-pick-name', title: row.repository }, row.repository),
            h('span', { className: 'hp-pick-v' }, '+' + fmtCount(row.starsGained)),
          );
        }),
      ),
    );

    // ── 右栏：多曲线图 ──
    const W = 760;
    const H = 340;
    const PAD = { l: 54, r: 16, t: 18, b: 30 };
    let chartNode = null;
    if (seriesList.length === 0) {
      chartNode = h('div', { className: 'hp-chart-empty' }, '勾选左侧项目后这里会画出它们的走势对比');
    } else if (frame) {
      const { minDate, maxDate, minV, maxV, lo, hi } = frame;
      const spanX = maxDate - minDate || 1;
      const px = (date) => PAD.l + ((Date.parse(date) - minDate) / spanX) * (W - PAD.l - PAD.r);
      /** 值 → 屏幕 y（对数）。 */
      const py = (v) => H - PAD.b - ((logV(v) - lo) / (hi - lo)) * (H - PAD.t - PAD.b);
      const val = (p) => p.gained;

      /**
       * y 轴刻度取「10 的整数次幂」：1 / 10 / 100 / 1k / 10k / 100k / 1M…
       * 只保留落在可视范围内的那些，最多 7 条 —— 这就是对数图的读法。
       */
      const decadeTicks = [];
      for (let e = 0; e <= 7; e += 1) {
        const value = Math.pow(10, e);
        if (logV(value) >= lo - 0.001 && logV(value) <= hi + 0.001) {
          decadeTicks.push({ value, y: py(value) });
        }
      }
      // 范围太窄（一个量级以内）时补中间刻度，避免只有一条线
      const gridLines = decadeTicks.length >= 2
        ? decadeTicks
        : [0, 0.25, 0.5, 0.75, 1].map((t) => {
            const target = lo + t * (hi - lo);
            const value = Math.pow(10, target) - LOG_BASE;
            return { value: Math.max(0, value), y: py(Math.max(0, value)) };
          });

      // x 轴日期刻度（5 个）
      const xTicks = [0, 0.25, 0.5, 0.75, 1].map((t) => {
        const ts = minDate + t * spanX;
        const d = new Date(ts);
        // 用 UTC 取月/日，避免本地时区把刻度挪一天
        return { x: px(new Date(ts).toISOString().slice(0, 10)), label: (d.getUTCMonth() + 1) + '/' + d.getUTCDate() };
      });

      chartNode = h(
        'div',
        // key 里带周期：换榜单时整个图重建一次，配 CSS 淡入，避免生硬跳变
        { className: 'hp-mchart', key: 'chart-' + periodKey },
        h(
          'svg',
          { viewBox: '0 0 ' + W + ' ' + H, className: 'hp-mchart-svg', role: 'img' },
          // 网格
          gridLines.map((g, i) =>
            h(
              'g',
              { key: 'g' + i },
              h('line', { x1: PAD.l, x2: W - PAD.r, y1: g.y, y2: g.y, className: 'hp-grid' }),
              h('text', { x: PAD.l - 8, y: g.y + 3.5, textAnchor: 'end', className: 'hp-axis' },
                g.value === 0 ? '0' : '+' + fmtCount(g.value)),
            ),
          ),
          // x 轴
          xTicks.map((t, i) => h('text', { key: 'x' + i, x: t.x, y: H - 9, textAnchor: 'middle', className: 'hp-axis' }, t.label)),
          // 零线（涨幅模式下有意义）
          minV < 0 && maxV > 0
            ? h('line', { x1: PAD.l, x2: W - PAD.r, y1: py(0), y2: py(0), className: 'hp-zero' })
            : null,
          // 每条曲线
          seriesList.map((s) => {
            const d = smoothPath(s.points.map((p) => [Number(px(p.date).toFixed(1)), Number(py(val(p)).toFixed(1))]));
            const dim = hover !== null && hover !== s.repo;
            return h('path', {
              d,
              fill: 'none',
              stroke: s.color,
              strokeWidth: hover === s.repo ? 2.8 : 1.9,
              strokeLinejoin: 'round',
              strokeLinecap: 'round',
              opacity: dim ? 0.22 : 1,
              // 换榜单时让线「重新画一遍」，视觉上说明数据换了
              className: 'hp-series',
              key: 'p-' + s.repo + '-' + periodKey,
              style: { transition: 'opacity .15s, stroke-width .15s' },
            });
          }),
          // 末端圆点
          // 每条线末端用**项目头像**代替圆点（像行情软件在线尾标品牌）。
          // 用 <clipPath> 裁成圆形；头像可能加载失败，失败时退化成同色圆点，绝不出现空白。
          seriesList.map((s, i) => {
            const last = s.points[s.points.length - 1];
            const cx = px(last.date);
            const cy = py(val(last));
            const r = 9;
            const owner = String(s.repo).split('/')[0] || '?';
            const clipId = 'hp-av-' + i;
            const dim = hover !== null && hover !== s.repo;
            return h(
              'g',
              { key: 'end' + s.repo, opacity: dim ? 0.25 : 1, style: { transition: 'opacity .15s' } },
              h(
                'defs',
                null,
                h('clipPath', { id: clipId }, h('circle', { cx, cy, r })),
              ),
              // 白色描边：让头像从深色/米色底上都浮出来
              h('circle', { cx, cy, r: r + 1.6, fill: 'var(--hp-card-bg, #fff)', opacity: 0.9 }),
              h('circle', { cx, cy, r, fill: s.color, opacity: 0.18 }),
              h('image', {
                href: BASE + '/avatar?owner=' + encodeURIComponent(owner),
                x: cx - r,
                y: cy - r,
                width: r * 2,
                height: r * 2,
                clipPath: 'url(#' + clipId + ')',
                preserveAspectRatio: 'xMidYMid slice',
              }),
              h('circle', { cx, cy, r, fill: 'none', stroke: s.color, strokeWidth: 1.6 }),
            );
          }),
        ),
        // 图例
        h(
          'div',
          { className: 'hp-legend' },
          seriesList.map((s) =>
            h(
              'button',
              {
                key: s.repo,
                className: 'hp-legend-item' + (hover === s.repo ? ' act' : ''),
                onMouseEnter: () => setHover(s.repo),
                onMouseLeave: () => setHover(null),
                onClick: () => toggle(s.repo),
                title: '点击移出对比',
              },
              h('span', { className: 'hp-legend-line', style: { background: s.color } }),
              h('span', null, s.repo.split('/')[1] || s.repo),
            ),
          ),
        ),
      );
    }

    // 上图下选：先给结论（走势图），再给操作（勾选）
    return h(
      'div',
      { className: 'hp-dash' },
      h(
        'section',
        { className: 'hp-mchart-panel' },
        h(
          'div',
          { className: 'hp-mchart-head' },
          h('div', { className: 'hp-mchart-title' }, '本期涨幅走势对比'),
          // 不再放「总星数 / 本期涨幅」切换：上面的「日/周/月」已经决定了周期，
          // 这里再让人选一次量纲就是重复决策。统一看「相对起点涨了多少」——
          // 它才是「谁这段涨得猛」的可比量（总星数比的是历史体量，与周期无关）。
          h('div', { className: 'hp-mchart-hint' }, '纵轴：本期涨幅（对数）'),
        ),
        chartNode,
        h(
          'div',
          { className: 'hp-mchart-note' },
          '纵轴为对数刻度（跨度大时也能看清各自走势）；所有曲线以同期为基准起算，中途才起来的项目从它出现那天开始画。',
        ),
      ),
      ready ? picker : null,
    );
  }

  /* ============================================================ 主面板 */

  function factory(require) {
    const React = require('react');
    const h = React.createElement;

    function Panel() {
      const [view, setView] = React.useState('cards'); // cards | dash
      const [period, setPeriod] = React.useState('day');
      const [boards, setBoards] = React.useState(null);
      const [loading, setLoading] = React.useState(true);
      const [error, setError] = React.useState(null);
      const [selected, setSelected] = React.useState(null);
      const [detail, setDetail] = React.useState(null);
      const [detailLoading, setDetailLoading] = React.useState(false);
      const [detailError, setDetailError] = React.useState(null);
      const [theme, setTheme] = React.useState(readTheme);
      const [lang, setLang] = React.useState(readLang);
      const [lastFetch, setLastFetch] = React.useState(null);
      /** { [repository]: { desc, chart } } —— 列表页卡片的简介与迷你走势 */
      const [details, setDetails] = React.useState(readDetailsCache);

      const loadBoards = React.useCallback(async (silent) => {
        if (!silent) setLoading(true);
        setError(null);
        try {
          const body = await getJson('/boards');
          setBoards(body.boards || []);
          setLastFetch(body.fetchedAt || null);
        } catch (e) {
          setError(String(e && e.message ? e.message : e));
        } finally {
          setLoading(false);
        }
      }, []);

      /**
       * 给当前可见的卡片批量补详情（简介 + 曲线），只取**还没有**的那些。
       * 宿主侧串行取、单条失败不影响其它；这里失败就静默跳过，卡片自动退回「无简介」形态。
       */
      /**
       * 详情加载：**缓存优先，后台更新**（stale-while-revalidate）。
       *
       * 加载行为分两步：
       *   ① 先从本地缓存把已有的（英文 + 中文）直接摆上屏 —— 不闪骨架、不等网络；
       *   ② 然后**不管有没有缓存**都去后台问一次，拿回新描述就更新。
       *
       * 注意：不能「有缓存就直接返回」，否则缓存永远不刷新，
       * 源站更新了描述也看不到。有缓存时同样需要发起更新请求。
       *
       * 并发控制：同一批 repo 在同一时刻只发一次请求（避免 effect 抖动打爆）。
       */
      /**
       * 分批加载详情 —— **先给前几屏，再补后面的**。
       *
       * 之前是一次性请求 20 个项目的简介+曲线+头像，再等翻译，
       * 结果首屏要等很久才出现内容。现在拆成 6 个一批：
       *   · 第 1 批（1~6）回来就立刻渲染，用户马上看到东西；
       *   · 后台接着请求 7~12、13~18、19~20，每批回来就补上。
       *
       * 关键：`known` 只用来判断「已经有的不用重复翻」，**不影响要不要发请求** ——
       * 有缓存也照样刷新（stale-while-revalidate）。
       */
      /**
       * 统一补中文译文：只翻还没有译文的那几条。
       * 单独抽出来，是因为它要在「所有数据批次取完」之后才跑，
       * 而且失败不该影响已显示的内容。
       */
      const loadTranslations = React.useCallback(async (needZh, gen) => {
        if (!needZh || needZh.length === 0) return;
        try {
          const tr = await getJson('/translate?repos=' + needZh.map(encodeURIComponent).join(',') + '&limit=20');
          if (generationRef.current !== gen) return;
          const zhMap = {};
          for (const it of tr.items || []) {
            if (it.descZh) zhMap[it.repository] = it.descZh;
          }
          if (Object.keys(zhMap).length > 0) {
            setDetails((prev) => {
              const merged = { ...prev };
              for (const [repo, descZh] of Object.entries(zhMap)) {
                if (merged[repo]) merged[repo] = { ...merged[repo], descZh };
              }
              return merged;
            });
          }
        } catch (e) {
          /* 翻译失败：留在英文原文 */
        }
      }, []);

      const inflightRef = React.useRef(new Set());
      const generationRef = React.useRef(0);
      const CHUNK = 6; // 每批条数：一屏 3 行卡片，够快看到结果

      const loadDetails = React.useCallback(async (repos, known, wantLang) => {
        if (!repos || repos.length === 0) return;
        const list = repos.slice(0, 20);
        const gen = generationRef.current;

        // 把 20 个切成若干 6 个一批
        const chunks = [];
        for (let i = 0; i < list.length; i += CHUNK) chunks.push(list.slice(i, i + CHUNK));

        for (let ci = 0; ci < chunks.length; ci += 1) {
          // 每批开始前检查代际：用户中途换了榜单/语言，剩下的批次直接放弃
          if (generationRef.current !== gen) return;
          const chunk = chunks[ci];
          const batchKey = wantLang + '|' + chunk.join(',');
          if (inflightRef.current.has(batchKey)) continue;
          inflightRef.current.add(batchKey);
          try {
            const q = chunk.map(encodeURIComponent).join(',');
            const noZh = wantLang === 'en' ? '&translate=0' : '';
            const body = await getJson('/batch?repos=' + q + '&limit=' + chunk.length + noZh);
            if (generationRef.current !== gen) return;

            // 这一批回来就立刻合并 → 界面马上多出 6 张有内容的卡
            const next = {};
            for (const it of body.items || []) {
              next[it.repository] = {
                desc: it.desc,
                descZh: it.descZh,
                chart: it.chart,
                descSource: it.descSource,
                avatar: it.avatar || null,
                settled: true,
              };
            }
            setDetails((prev) => {
              const merged = { ...prev };
              for (const [repo, fresh] of Object.entries(next)) {
                const old = prev[repo];
                const keepOld = !fresh.desc && old && old.desc;
                merged[repo] = keepOld
                  ? { ...old, chart: fresh.chart || old.chart, avatar: fresh.avatar || old.avatar, settled: true }
                  : { ...fresh, descZh: fresh.descZh || (old && old.descZh) || null };
              }
              return merged;
            });
          } catch (e) {
            if (generationRef.current !== gen) return;
            // 这一批失败：把还没取过的标成 settled，避免永远转圈
            const fallback = {};
            for (const r of chunk) {
              if (!known[r]) fallback[r] = { desc: null, descZh: null, chart: null, settled: true };
            }
            if (Object.keys(fallback).length > 0) {
              setDetails((prev) => ({ ...fallback, ...prev }));
            }
          } finally {
            inflightRef.current.delete(batchKey);
          }
        }

        /**
         * 全部批次取完后，补一次中文。
         *
         * 这里必须**从 known 快照算需要翻译的条目**，不能在 setDetails 的
         * 回调里做副作用 —— 那样在 React 严格模式下会执行两次，
         * 而且 setter 应当保持纯函数。
         */
        if (wantLang === 'zh' && generationRef.current === gen) {
          const needZh = list.filter((r) => {
            const entry = known[r];
            // 有简介、但还没有译文 → 需要翻
            return entry && entry.desc && !entry.descZh;
          });
          if (needZh.length > 0) void loadTranslations(needZh, gen);
        }
      }, [loadTranslations]);

      React.useEffect(() => {
        void loadBoards(false);
        // 数据源每天只更新一次，所以不做分钟级轮询；只在**跨天**时自动静默刷新一次。
        // 判断方式：记住首次加载那天的日期，页面开着跨过零点才重新取。
        const openedDay = localDayKey();
        const timer = setInterval(() => {
          if (localDayKey() !== openedDay) {
            clearInterval(timer);
            void loadBoards(true);
          }
        }, 60 * 1000);
        return () => clearInterval(timer);
      }, [loadBoards]);

      const board = React.useMemo(() => {
        if (!boards) return null;
        return boards.find((b) => b.id === period) || boards[0] || null;
      }, [boards, period]);

      const openDetail = React.useCallback(async (item) => {
        setSelected(item);
        setDetail(null);
        setDetailError(null);
        setDetailLoading(true);
        try {
          const body = await getJson('/detail?repo=' + encodeURIComponent(item.repository));
          setDetail(body.detail || null);
        } catch (e) {
          setDetailError(String(e && e.message ? e.message : e));
        } finally {
          setDetailLoading(false);
        }
      }, []);

      const rows = board && Array.isArray(board.rows) ? board.rows : [];
      const maxGain = React.useMemo(() => rows.reduce((m, r) => Math.max(m, r.starsGained || 0), 0), [rows]);
      /** 只看前 20 —— 再多就是噪音，所以这里硬截断。 */
      const visible = React.useMemo(() => rows.slice(0, MAX_ITEMS), [rows]);
      const top20Gain = React.useMemo(() => visible.reduce((sum, r) => sum + (r.starsGained || 0), 0), [visible]);
      /** { repo: chart } —— 只挑出真正有曲线的那些，图表组件不认识 desc 之类 */
      const chartMap = React.useMemo(() => {
        const out = {};
        for (const [repo, entry] of Object.entries(details || {})) {
          if (entry && entry.chart && Array.isArray(entry.chart.series)) out[repo] = entry.chart;
        }
        return out;
      }, [details]);

      /**
       * 可见项目变了（换榜单/换周期）或语言变了 → 去取一次详情。
       *
       * ⚠️ 这里**只依赖项目列表与语言**，不依赖 details —— 否则
       * 「取回 → setDetails → 触发 effect → 又取回」会转圈。
       * 是否有缓存由 loadDetails 内部判断（有缓存也照样更新，见它的注释）。
       */
      const repoListKey = React.useMemo(() => visible.map((r) => r.repository).join('|'), [visible]);

      // details 的最新值放 ref 里：effect 要读它判断「哪些还没有」，
      // 但不能把它写进依赖（否则取回→setDetails→再取回 会转圈）。
      const detailsRef = React.useRef(details);
      React.useEffect(() => { detailsRef.current = details; }, [details]);

      React.useEffect(() => {
        if (!repoListKey) return;
        // 每次换榜单/语言：代际 +1，让在途的旧请求作废
        generationRef.current += 1;
        void loadDetails(repoListKey.split('|'), detailsRef.current, lang);
      }, [repoListKey, lang, loadDetails]);

      // 详情变化就落本地缓存（节流交给浏览器，量很小）
      React.useEffect(() => {
        if (Object.keys(details).length > 0) writeDetailsCache(details);
      }, [details]);

      /** 切换语言：换偏好、清掉已缓存的详情（否则拿的还是旧语言那批），再重取一次。 */
      /**
       * 切换语言。
       *
       * ⚠️ 这里**不能清空 details**：清空会让所有卡片回到骨架并重新请求，
       * 表现为切换瞬间内容全消失。
       *
       * 正确做法：保留已有内容（英文/中文都在 details 里），只改变「显示哪一份」，
       * 需要译文时由 effect 触发补译。内容不清空 → 不闪。
       */
      const toggleLang = React.useCallback(() => {
        setLang((cur) => {
          const next = cur === 'zh' ? 'en' : 'zh';
          writeLang(next);
          return next;
        });
      }, []);

      /**
       * 切到「中文」时，立刻给已有内容补译文 —— **不等重新取数**。
       *
       * 为什么单独做：切语言时数据已经在了（英文简介在 details 里），
       * 如果等 loadDetails 重新跑一遍批次才去翻译，会绕一大圈还可能被代际作废。
       * 这里直接看「哪些有英文没中文」，发一次翻译请求就够了。
       */
      React.useEffect(() => {
        if (lang !== 'zh') return;
        const gen = generationRef.current;
        const need = [];
        for (const [repo, entry] of Object.entries(detailsRef.current || {})) {
          if (entry && entry.desc && !entry.descZh) need.push(repo);
        }
        if (need.length > 0) void loadTranslations(need.slice(0, 20), gen);
      }, [lang, loadTranslations]);

      const toggleTheme = React.useCallback(() => {
        setTheme((cur) => {
          const next = cur === 'paper' ? 'dark' : 'paper';
          writeTheme(next);
          return next;
        });
      }, []);

      const periodLabel = board ? board.label : '—';
      const dataOk = board && board.ok;
      const dataStale = board && !board.ok && board.staleAt;

      const header = h(
        'div',
        { className: 'hp-head' },
        h('div', { className: 'hp-brand' },
          h('span', { className: 'hp-brand-icon', dangerouslySetInnerHTML: { __html: BRAND_ICON_SVG } }),
          'GitHub Hot',
          ),
        h('div', { className: 'hp-spacer' }),
        // 右侧操作区：周期切换 → 视图切换 → 主题 → 刷新
        h(
          'div',
          { className: 'hp-actions' },
          h(
            'div',
            { className: 'hp-seg' },
            h('button', { className: period === 'day' ? 'on' : '', onClick: () => setPeriod('day') }, '日榜'),
            h('button', { className: period === 'week' ? 'on' : '', onClick: () => setPeriod('week') }, '周榜'),
            h('button', { className: period === 'month' ? 'on' : '', onClick: () => setPeriod('month') }, '月榜'),
          ),
          h(
            'div',
            { className: 'hp-seg' },
            h('button', { className: view === 'cards' ? 'on' : '', onClick: () => setView('cards'), title: '按名次看每个项目' }, '榜单'),
            h('button', { className: view === 'dash' ? 'on' : '', onClick: () => setView('dash'), title: '汇总统计：多少仓库、多少星、什么语言' }, '统计'),
          ),
        ),
        // 一句话说清「数据是哪天的」。不再罗列取回时刻与起止日期 —— 那对读的人没有意义。
        h(
          'div',
          { className: 'hp-meta' },
          h(
            'span',
            { title: lastFetch ? '本机取回于 ' + fmtTime(lastFetch) : '' },
            h('span', { className: 'hp-dot ' + (dataOk ? 'ok' : dataStale ? 'warn' : 'bad') }),
            dataOk
              ? '数据更新到 ' + dataDateText(board)
              : dataStale
                ? '暂未取到 · 显示 ' + ago(board.staleAt) + ' 的数据'
                : '暂未取到数据',
          ),
        ),
        h(
          'div',
          { className: 'hp-actions' },
          h(
            'button',
            {
              className: 'hp-btn hp-lang-btn',
              onClick: toggleLang,
              title: lang === 'zh' ? '当前显示中文（等翻译完成）。点击切到英文，加载更快' : '当前显示英文原文。点击切回中文',
            },
            lang === 'zh' ? '中' : 'EN',
          ),
          h(
            'button',
            { className: 'hp-btn hp-theme-btn', onClick: toggleTheme, title: theme === 'paper' ? '切到深色（融入界面）' : '切到纸感贴纸风' },
            theme === 'paper' ? '◐ 深色' : '◑ 纸感',
          ),
          h('button', { className: 'hp-btn', onClick: () => void loadBoards(false), disabled: loading }, loading ? '刷新中…' : '刷新'),
        ),
      );

      let body;
      if (loading && !boards) {
        body = h(
          'div',
          { className: 'hp-cards' },
          Array.from({ length: 6 }, (_, i) => h('div', { className: 'hp-card-loading', key: i })),
        );
      } else if (error && !boards) {
        body = h(
          'div',
          { className: 'hp-empty' },
          h('strong', null, '取数失败'),
          h('div', null, error),
          h('div', null, '检查网络连接，然后点右上角「刷新」。'),
        );
      } else if (!dataOk && rows.length === 0) {
        body = h(
          'div',
          { className: 'hp-empty' },
          h('strong', null, periodLabel + ' 暂时拿不到'),
          h('div', null, board && board.error ? String(board.error) : '未知原因'),
          h('div', null, '数据每天更新一次，稍后重试即可。'),
        );
      } else if (view === 'dash') {
        // 统计只看展示的那一批，与榜单页口径一致。
        // details 是 { repo: { desc, chart } }，这里抽成 { repo: chart } 再传 —— 图表组件只认曲线。
        body = h(Dashboard, { React, rows: visible, charts: chartMap, lang, periodKey: period });
      } else {
        body = h(
          'div',
          null,
          // ── 首屏唯一主角：本期合计涨星（先给答案，再给证据）──
          h(
            'div',
            { className: 'hp-hero' },
            h(
              'div',
              { className: 'hp-hero-main' },
              h('div', { className: 'hp-hero-k' }, periodLabel + ' · TOP ' + Math.min(MAX_ITEMS, rows.length) + ' 合计涨星'),
              h('div', { className: 'hp-hero-v' }, '+' + fmtCount(top20Gain)),
              h(
                'div',
                { className: 'hp-hero-sub' },
                dataOk && rows.length > 0
                  ? '最高 ' + rows[0].repository.replace('/', ' / ') + ' 单项涨 ' + fmtCount(rows[0].starsGained) + ' 星'
                  : '暂无数据',
              ),
            ),
            h(
              'div',
              { className: 'hp-hero-side' },
              h('div', { className: 'hp-stat-card rose' }, h('div', { className: 'hp-stat-k' }, 'TOP20 平均'), h('div', { className: 'hp-stat-v' }, '+' + fmtCount(Math.round(top20Gain / (visible.length || 1))))),
              h('div', { className: 'hp-stat-card sky' }, h('div', { className: 'hp-stat-k' }, '最高单项'), h('div', { className: 'hp-stat-v' }, visible.length ? '+' + fmtCount(visible[0].starsGained) : '—')),
              h('div', { className: 'hp-stat-card sun' }, h('div', { className: 'hp-stat-k' }, '展示条数'), h('div', { className: 'hp-stat-v' }, visible.length + ' 个')),
            ),
          ),
          h(
            'div',
            { className: 'hp-cards' },
            visible.map((item) =>
              h(Card, {
                key: item.repository + ':' + item.rank,
                React,
                lang,
                detail: details[item.repository] || null,
                item,
                maxGain,
                isSel: selected && selected.repository === item.repository,
                onSelect: (it) => void openDetail(it),
              }),
            ),
          ),
        );
      }

      return h(
        'div',
        { className: 'hp-root hp-' + theme },
        header,
        dataStale ? h('div', { className: 'hp-banner warn' }, '本次取数失败（' + board.error + '），显示的是 ' + ago(board.staleAt) + ' 的数据。') : null,
        selected ? h(Detail, { React, item: selected, detail, loading: detailLoading, error: detailError, onClose: () => setSelected(null) }) : null,
        h('div', { className: 'hp-scroll' }, body),
        /**
         * 数据署名 —— **不是装饰，是法律要求**。
         *
         * 榜单数据来自 Hysen Labs，按 CC BY 4.0 授权：可以免费用，但必须
         *   · credit（署名）：写出 Hysen Labs
         *   · link（链接）：链到来源页
         * 去掉这行就是侵权。放在底部小字，不影响主视觉。
         */
        h(
          'footer',
          { className: 'hp-attr', title: '榜单数据来自 Hysen Labs，按 CC BY 4.0 许可使用' },
          h('a', { href: 'https://hysenlabs.com', target: '_blank', rel: 'noreferrer' }, 'Hysen Labs'),
          h('span', { className: 'hp-attr-dot' }, '·'),
          'CC BY 4.0',
        ),
        selected
          ? h('div', { className: 'hp-scroll', style: { flex: '0 0 auto', maxHeight: 0 } })
          : null,
      );
    }

    return {
      name: PLUGIN_NAME,
      inject: ['slots'],
      apply(ctx) {
        try {
          ensureCss(document);
        } catch (e) {
          console.warn('[dsh-github-hot] 样式注入失败：' + (e instanceof Error ? e.message : String(e)));
        }
        ctx.slots.inject('main', function* () {
          yield ctx.slots.register({ name: 'main', key: PLUGIN_NAME, order: 45 }, Panel);
        });
        ctx.slots.inject('sidebar.panellist', function* () {
          yield ctx.slots.register(
            { name: 'sidebar.panellist', id: PLUGIN_NAME, order: 45, label: () => 'GitHub Hot' },
            function SidebarIcon() {
              // 用内联 SVG 线条图标，而不是 emoji —— 侧栏里其它插件都是线条图标，
              // 一个彩色 emoji 摆进去会显眼得突兀。
              // 三条并行上升线：与「GitHub 热榜 / GitHub 趋势」的单折线同风格，但图形不同。
              return h('span', {
                className: 'hp-side-icon',
                title: 'GitHub Hot · 多项目涨星走势对比',
                dangerouslySetInnerHTML: { __html: SIDEBAR_ICON_SVG },
              });
            },
          );
        });
      },
    };
  }

  if (typeof window !== 'undefined' && window.__ModuleLoader__ && typeof window.__ModuleLoader__.load === 'function') {
    window.__ModuleLoader__.load({ id: PLUGIN_NAME, factory });
  }

  // 仅供测试：把这些纯渲染组件挂在全局名下一个不冲突的键上，
  // 测试脚本可以直接对**真实组件**做同构渲染断言，而不是复制一份等价逻辑去测。
  if (typeof globalThis !== 'undefined') {
    globalThis.__DSH_HYSEN_PULSE_TEST__ = { StarChart, Card, Detail, Dashboard, fmtCount, fmtPct, gainTone };
  }
})();
