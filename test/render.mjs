/**
 * 用**真实 React 18** 渲染测试（不是替身）。
 *
 * 为什么不用替身：React 的 hook 语义（顺序、批次更新、effect 时序）很微妙，
 * 手写替身会在「异步 setState 后重渲染」这类路径上给出假结果。这里直接 require
 * 本机已安装的 react，用 react-dom/server 渲染成 HTML 再断言。
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';

// ⚠️ 关键：pnpm 隔离依赖下，react-dom 必须从**它自己的目录**解析，
// 否则拿到的是另一份 React 副本，renderToString 会报 "Objects are not valid as a React child"。
import { loadReact } from './_react.mjs';
const _r = loadReact();
if (!_r) { console.log('（本机未找到 React，跳过此测试）'); process.exit(0); }
const { React, renderToString } = _r;

let pass = 0, fail = 0;
const ok = (c, m, extra) => { if (c) { pass++; console.log('  ✓ ' + m); } else { fail++; console.log('  ✗ ' + m + (extra ? ' | ' + extra : '')); } };

/* ---------- 拉真实数据 ---------- */
const UA = { 'User-Agent': 'dsh-hysen-pulse/test' };
const csv = await (await fetch('https://hysenlabs.com/data/star-growth-24h.csv', { headers: UA })).text();
const lines = csv.trim().split('\n'); const head = lines[0].split(',');
const rows = lines.slice(1, 11).map((line) => {
  const c = line.split(','); const o = {}; head.forEach((k, i) => o[k] = c[i]);
  return { rank: +o.rank, repository: o.repository, slug: 's', githubUrl: 'https://github.com/' + o.repository,
    hysenUrl: 'https://hysenlabs.com/projects/s', starsGained: +o.stars_gained,
    startStars: +o.start_stars, endStars: +o.end_stars,
    growthPct: Number.isFinite(+o.growth_pct) ? +o.growth_pct : null,
    rankChange: null, language: o.language, license: o.license, desc: null };
});
console.log('真实数据: ' + rows.length + ' 项，首项 ' + rows[0].repository + ' +' + rows[0].starsGained);

/* ---------- 加载 client.js ---------- */
const styles = [];
const doc = { getElementById: (id) => styles.find(s => s.id === id) || null,
  createElement: () => ({ id: '', textContent: '' }), head: { appendChild: (el) => styles.push(el) } };

const boardsBody = { ok: true, fetchedAt: new Date().toISOString(), boards: [
  { id: 'day', label: '日榜', ok: true, rows, window: { start: '2026-11-02', end: '2026-11-03' }, error: null },
  { id: 'week', label: '周榜', ok: true, rows: rows.slice(0, 10), window: null, error: null },
  { id: 'month', label: '月榜', ok: true, rows, window: { start: '2026-10-04', end: '2026-11-03' }, error: null },
] };

let reg = null;
const sb = {
  console, document: doc, setTimeout, clearTimeout, setInterval: () => 0, clearInterval: () => {},
  AbortController,
  fetch: async (url) => ({ ok: true, status: 200, json: async () =>
    String(url).includes('/detail') ? { ok: true, detail: null } : boardsBody }),
  window: { __ModuleLoader__: { load: (d) => { reg = d; } } },
};
vm.createContext(sb);
vm.runInContext(readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8'), sb);

const mod = reg.factory((name) => { if (name === 'react') return React; throw new Error('unexpected ' + name); });

/* ---------- 抓组件 ---------- */
let MainComp = null, SidebarComp = null;
mod.apply({ slots: {
  inject: (slot, gen) => { const it = gen(); it.next(); },
  register: (spec, comp) => { if (spec.name === 'main') MainComp = comp; if (spec.name === 'sidebar.panellist') SidebarComp = comp; return () => {}; },
}});

console.log('\n[1] 组件挂载');
ok(typeof MainComp === 'function', 'main 组件存在');
ok(typeof SidebarComp === 'function', '侧栏组件存在');

/* ---------- 渲染（初始 loading 态）---------- */
async function renderAsync(comp) {
  // 用 renderToString 渲染首帧（loading 态）
  const html = renderToString(React.createElement(comp));
  return html;
}
let html = '';
try { html = await renderAsync(MainComp); ok(true, '首帧渲染成功'); }
catch (e) { ok(false, '首帧渲染失败', e.message); }

console.log('\n[2] 首帧结构（加载中）');
ok(html.includes('hp-root'), '根容器在');
ok(html.includes('日榜') && html.includes('周榜') && html.includes('月榜'), '三个周期按钮');
ok(html.includes('榜单') && html.includes('统计'), '两个视图切换（榜单 / 统计）');
// 底部的 CC BY 署名是法定要求，必须出现；正文部分则不该出现数据源名
ok(html.includes('数据来自'), '底部有数据署名（CC BY 4.0 要求）');
ok(/Hysen Labs/.test(html), '署名写明 Hysen Labs');
ok(html.includes('hp-card-loading'), '显示骨架屏（加载态）');

console.log('\n[3] 侧栏渲染');
try {
  const sHtml = renderToString(React.createElement(SidebarComp));
  // 图标已从 emoji 换成内联 SVG 线条图（与侧栏其它插件同风格）
  ok(sHtml.includes('<svg') && sHtml.includes('stroke="currentColor"'), '侧栏用 SVG 线条图标');
  ok(!/📈|📊|🔥/.test(sHtml), '不再使用 emoji 图标');
  ok(sHtml.includes('currentColor'), '图标继承文字色（适配深浅主题）');
  // 单折线 + 箭头：与「GitHub 热榜 / 趋势」同款画法，18px 下才认得清
  ok((sHtml.match(/<path/g) || []).length >= 2, '折线 + 箭头两段路径');
  ok(!sHtml.includes('circle'), '没有多余装饰（圆点等）');
} catch (e) { ok(false, '侧栏渲染失败', e.message); }

console.log('\n结果: ' + pass + ' 通过 / ' + fail + ' 失败');
process.exit(fail === 0 ? 0 : 1);
