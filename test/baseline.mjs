/**
 * 基准日测试：验证多曲线对比用「同一天当零点」，且允许中途起来的项目。
 *
 * 口径（用户要求）：
 *   1. 所有曲线以同一天为基准（不是各自第一天的 0 点）；
 *   2. 不从 0 开始也没关系 —— 每条线从自己第一次有数据那天开始画；
 *   3. 中途才出现的项目，从它出现那天才开始，不需要从最左边硬接。
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

// ---- 加载 client ----
const doc = { getElementById: () => null, createElement: () => ({ id: '', textContent: '' }), head: { appendChild: () => {} } };
let reg = null;
const sb = { console, document: doc, setTimeout, clearTimeout, setInterval: () => 0, clearInterval: () => {},
  AbortController, fetch: async () => ({ ok: true, json: async () => ({ ok: true }) }),
  localStorage: { getItem: () => null, setItem: () => {} },
  window: { __ModuleLoader__: { load: (d) => { reg = d; } } } };
sb.globalThis = sb;
vm.createContext(sb);
vm.runInContext(readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8'), sb);
reg.factory((n) => { if (n === 'react') return React; throw new Error(n); });
const T = sb.__DSH_HYSEN_PULSE_TEST__;

// ---- 构造两条起始日不同的曲线 ----
// A：8/1 起就有数据（500 → 900）；B：9/15 才出现（100 → 400）
const mkSeries = (startDate, points) => {
  const out = [];
  let d = new Date(startDate + 'T00:00:00Z');
  for (let i = 0; i < points.length; i += 1) {
    out.push({ date: d.toISOString().slice(0, 10), stars: points[i], x: i, y: i });
    d = new Date(d.getTime() + 86400000);
  }
  return { series: out, xLabels: [], yTicks: [], range: null };
};
const chartA = mkSeries('2026-08-01', [500, 600, 700, 800, 900]);
const chartB = mkSeries('2026-09-15', [100, 200, 300, 400]);

const rows = [
  { repository: 'a/early', rank: 1, starsGained: 400, language: 'TypeScript' },
  { repository: 'b/late', rank: 2, starsGained: 300, language: 'Rust' },
];
const charts = { 'a/early': chartA, 'b/late': chartB };

ok(!!T, '组件暴露');
ok(!!T.Dashboard, 'Dashboard 可用');

const html = renderToString(React.createElement(T.Dashboard, { React, rows, charts, lang: 'zh' }));
ok(html.includes('<svg'), '渲染出 SVG');
ok((html.match(/<path/g) || []).length >= 2, '两条曲线都画出来了');

// 从 SVG 的 polyline/path 里取坐标，验证：
// ① B 的线不应该在 A 的起点（8/1）就有值 —— 它最早的点必须晚于 A
const paths = [...html.matchAll(/d="(M[^"]+)"/g)].map((m) => m[1]);
ok(paths.length >= 2, '拿到 ' + paths.length + ' 条 path 的 d');
const starts = paths.map((d) => {
  const m = d.match(/M([\d.]+) ([\d.]+)/);
  return m ? { x: Number(m[1]), y: Number(m[2]) } : null;
}).filter(Boolean);
ok(starts.length >= 2, '每条线都有起点');

// 找两条线的起点 x：早起的项目起点更靠左
const xs = starts.map((s) => s.x).sort((a, b) => a - b);
ok(xs[0] < xs[xs.length - 1], '两条线的起点 x 不同（' + xs[0].toFixed(0) + ' vs ' + xs[xs.length-1].toFixed(0) + '）—— 中途起来的项目确实从更晚的位置开始');

console.log('\n结果: ' + pass + ' 通过 / ' + fail + ' 失败');
process.exit(fail === 0 ? 0 : 1);
