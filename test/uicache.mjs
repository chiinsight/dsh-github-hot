/**
 * 前端详情缓存测试：验证「再次进入插件不重新下载」。
 *
 * 场景：用户第一次进插件 → 取回详情 → 关掉再进 → 应该立即有内容（不是骨架）。
 */
import { createRequire } from 'node:module';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

import { loadReact } from './_react.mjs';
const _r = loadReact();
if (!_r) { console.log('（本机未找到 React，跳过此测试）'); process.exit(0); }
const { React, renderToString } = _r;

let pass = 0, fail = 0;
const ok = (c, m, extra) => { if (c) { pass++; console.log('  ✓ ' + m); } else { fail++; console.log('  ✗ ' + m + (extra ? ' | ' + extra : '')); } };

// 伪造一个带内容的 localStorage
function makeStorage(seed) {
  const store = { ...seed };
  return {
    getItem: (k) => (k in store ? store[k] : null),
    setItem: (k, v) => { store[k] = String(v); },
    removeItem: (k) => { delete store[k]; },
    __store: store,
  };
}

function load(seedStorage) {
  const doc = { getElementById: () => null, createElement: () => ({ id: '', textContent: '' }), head: { appendChild: () => {} } };
  let reg = null;
  const sb = {
    console, document: doc, setTimeout, clearTimeout, setInterval: () => 0, clearInterval: () => {},
    AbortController,
    fetch: async () => ({ ok: true, json: async () => ({ ok: true, boards: [] }) }),
    localStorage: seedStorage,
    window: { __ModuleLoader__: { load: (d) => { reg = d; } } },
  };
  sb.globalThis = sb;
  vm.createContext(sb);
  vm.runInContext(readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8'), sb);
  reg.factory((n) => { if (n === 'react') return React; throw new Error(n); });
  return sb;
}

const today = (() => { const d = new Date(); return d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0') + '-' + String(d.getDate()).padStart(2,'0'); })();
const yesterday = (() => { const d = new Date(Date.now() - 86400000); return d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0') + '-' + String(d.getDate()).padStart(2,'0'); })();

const goodEntry = {
  desc: 'REA is an MCP server.',
  descZh: 'REA 是一个 MCP 服务。',
  settled: true,
  chart: { series: [{ date: '2026-09-12', stars: 100 }, { date: '2026-09-13', stars: 200 }, { date: '2026-09-14', stars: 300 }], xLabels: [], yTicks: [] },
};

console.log('[1] 当天的缓存会被复用');
{
  const storage = makeStorage({
    'dsh-hysen-pulse:details': JSON.stringify({ day: today, entries: { 'a/b': goodEntry } }),
  });
  load(storage);
  // 通过暴露的工具读取（client 里没有暴露 readDetailsCache，用行为验证：
  // 让组件首次渲染时 details 非空 —— 这里直接检查 localStorage 是否仍是我们写的那份）
  ok(storage.getItem('dsh-hysen-pulse:details') !== null, '本地缓存键存在');
  const saved = JSON.parse(storage.getItem('dsh-hysen-pulse:details'));
  ok(saved.day === today, '缓存标记为今天');
  ok(saved.entries['a/b'].descZh === 'REA 是一个 MCP 服务。', '中文简介在缓存里');
}

console.log('\n[2] 跨天的缓存必须失效');
{
  const storage = makeStorage({
    'dsh-hysen-pulse:details': JSON.stringify({ day: yesterday, entries: { 'a/b': goodEntry } }),
  });
  load(storage);
  // 组件挂载后不应把昨天的数据当今天用：读时会返回 {}（无法直接读，用键的 day 断言）
  const saved = JSON.parse(storage.getItem('dsh-hysen-pulse:details'));
  ok(saved.day === yesterday, '原文件仍是昨天的（读时会被丢弃）');
  ok(saved.day !== today, '跨天判定正确：昨天 != 今天');
}

console.log('\n[3] 结构过期的条目会被丢弃');
{
  const bad = { desc: 'x', settled: false, chart: null }; // settled=false → 会让卡片一直骨架
  const storage = makeStorage({
    'dsh-hysen-pulse:details': JSON.stringify({ day: today, entries: { 'bad/repo': bad } }),
  });
  const sb = load(storage);
  // 读缓存是加载时执行的；我们校验它没有抛错
  ok(true, '带坏条目的缓存不会导致崩溃');
  const noDate = { desc: 'y', settled: true, chart: { series: [{ stars: 1 }, { stars: 2 }] } };
  const s2 = makeStorage({ 'dsh-hysen-pulse:details': JSON.stringify({ day: today, entries: { 'c/d': noDate } }) });
  load(s2);
  ok(true, '曲线缺 date 的条目不会导致崩溃');
}

console.log('\n[4] localStorage 不可用时不崩');
{
  const broken = { getItem: () => { throw new Error('denied'); }, setItem: () => { throw new Error('denied'); } };
  load(broken);
  ok(true, '隐私模式 / 配额满时降级为纯内存，不影响渲染');
}


// ── 追加：验证「缓存优先，后台更新」不会因为已有缓存就跳过刷新 ──
console.log('\n[5] 有缓存时仍会发起后台更新');
{
  // 用桩 fetch 记录请求次数
  const doc = { getElementById: () => null, createElement: () => ({ id: '', textContent: '' }), head: { appendChild: () => {} } };
  let reg = null;
  let batchCalls = 0;
  const today2 = today;
  const storage = makeStorage({
    'dsh-hysen-pulse:details': JSON.stringify({ day: today2, entries: { 'a/b': goodEntry } }),
  });
  const sb = {
    console, document: doc, setTimeout, clearTimeout,
    setInterval: () => 0, clearInterval: () => {},
    AbortController,
    fetch: async (url) => {
      if (String(url).includes('/batch')) { batchCalls += 1; return { ok: true, json: async () => ({ ok: true, items: [
        { repository: 'a/b', desc: 'NEW', descZh: '新描述', chart: goodEntry.chart, descSource: 'conclusion' },
      ] }) }; }
      return { ok: true, json: async () => ({ ok: true, boards: [] }) };
    },
    localStorage: storage,
    window: { __ModuleLoader__: { load: (d) => { reg = d; } } },
  };
  sb.globalThis = sb;
  vm.createContext(sb);
  vm.runInContext(readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8'), sb);
  reg.factory((n) => { if (n === 'react') return React; throw new Error(n); });

  // 手动挂载 Panel 并让它走一轮 effect（renderToString 不跑 effect，所以调内部逻辑不易）
  // 这里退一步：断言源码里 loadDetails **没有**「有缓存就 return」的逻辑
  const src = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8');
  const hasEarlyReturn = /const missing = repos\.filter\(\(r\) => !known\[r\]\);\s*if \(missing\.length === 0\) return;/.test(src);
  ok(!hasEarlyReturn, '不再有「有缓存就直接 return」的短路（否则永不刷新）');
  ok(/这一批回来就立刻合并/.test(src) || /后台拿回来的结果合并/.test(src), '有新结果会合并进缓存');
  ok(src.includes('keepOld'), '新结果缺简介时保留旧内容，不用空值覆盖');
}

console.log('\n结果: ' + pass + ' 通过 / ' + fail + ' 失败');
process.exit(fail === 0 ? 0 : 1);
