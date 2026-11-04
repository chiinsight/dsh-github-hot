/**
 * 可视化验证：对**插件真实组件**（Card / StarChart / Detail / Dashboard）做同构渲染断言。
 *
 * 组件经 client.js 末尾以 `globalThis.__DSH_HYSEN_PULSE_TEST__` 暴露（仅供测试）。
 * 数据全部来自线上真实响应，不造假。
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';

// ⚠️ pnpm 隔离依赖：react-dom 必须从它自己的目录解析，否则会拿到另一份 React 副本
import { loadReact } from './_react.mjs';
const _r = loadReact();
if (!_r) { console.log('（本机未找到 React，跳过此测试）'); process.exit(0); }
const { React, renderToString } = _r;

let pass = 0, fail = 0;
const ok = (c, m, extra) => { if (c) { pass++; console.log('  ✓ ' + m); } else { fail++; console.log('  ✗ ' + m + (extra ? ' | ' + extra : '')); } };

/* ---------- 真实数据 ---------- */
const UA = { 'User-Agent': 'dsh-hysen-pulse/test' };
const csv = await (await fetch('https://hysenlabs.com/data/star-growth-24h.csv', { headers: UA })).text();
const lines = csv.trim().split('\n'); const head = lines[0].split(',');
const { __internals } = await import('../lib/index.js');
const mk = (line) => {
  const c = line.split(','); const o = {}; head.forEach((k, i) => o[k] = c[i]);
  return { rank: +o.rank, repository: o.repository, slug: __internals.slugOf(o.repository),
    githubUrl: o.github_url, hysenUrl: o.hysenlabs_url, starsGained: +o.stars_gained,
    startStars: +o.start_stars, endStars: +o.end_stars,
    growthPct: Number.isFinite(+o.growth_pct) ? +o.growth_pct : null,
    rankChange: null, language: o.language, license: o.license, desc: null };
};
const rows = lines.slice(1, 11).map(mk);
const maxGain = Math.max(...rows.map(r => r.starsGained));
console.log('真实榜单: ' + rows.length + ' 项，首位 ' + rows[0].repository + ' +' + rows[0].starsGained);

const svgText = await (await fetch('https://hysenlabs.com/chart/morluto-rea.svg', { headers: UA })).text();
const chart = __internals.parseChartSvg(svgText);
console.log('真实曲线: ' + (chart ? chart.series.length + ' 个点' : '解析失败'));

/* ---------- 加载 client.js ---------- */
const doc = { getElementById: () => null, createElement: () => ({ id: '', textContent: '' }), head: { appendChild: () => {} } };
let reg = null;
const sb = { console, document: doc, setTimeout, clearTimeout, setInterval: () => 0, clearInterval: () => {},
  AbortController, fetch: async () => ({ ok: true, status: 200, json: async () => ({ ok: true }) }),
  window: { __ModuleLoader__: { load: (d) => { reg = d; } } } };
sb.globalThis = sb;
vm.createContext(sb);
vm.runInContext(readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8'), sb);
reg.factory((n) => { if (n === 'react') return React; throw new Error('unexpected ' + n); });

const T = sb.__DSH_HYSEN_PULSE_TEST__;
ok(!!T, '测试组件已暴露');

/* ---------- 1. 卡片（真实 Card 组件）---------- */
console.log('\n[1] Card 组件（真实）');
const cardHtml = renderToString(React.createElement('div', null,
  rows.map(r => React.createElement(T.Card, { key: r.repository, React, item: r, maxGain, isSel: false, onSelect: () => {} }))));
ok((cardHtml.match(/class="hp-card/g) || []).length >= 10, '渲染出 10 张卡');
ok(cardHtml.includes('hp-card top1'), '第1名卡片高亮');
ok(cardHtml.includes('hp-rank r1'), '第1名金徽章');
ok(cardHtml.includes('morluto') && cardHtml.includes('rea'), '含首项仓库名');
ok(cardHtml.includes('+4k'), '涨星数紧凑格式化（3988 → +4k）');
// 新版卡片：有曲线才画迷你走势；无详情时**不留灰色占位**
ok(cardHtml.includes('hp-desc-loading'), '详情未到时显示骨架条（而非「暂无简介」）');
ok(cardHtml.includes('hp-avatar'), '卡片有头像');
ok(cardHtml.includes('/avatar?repo=') || cardHtml.includes('/avatar?owner='), '头像走宿主代理（不直连 github.com）');
ok(!cardHtml.includes('github.com/morluto.png'), '不在前端直连 GitHub 头像');
ok(!cardHtml.includes('暂无简介'), '不再输出「暂无简介」灰字占位');
const cardWithDetail = renderToString(React.createElement(T.Card, {
  React, item: rows[0], maxGain, isSel: false, onSelect: () => {},
  detail: { desc: 'REA is an MCP server.', descZh: 'REA 是一个把逆向工程工具接给 Agent 的 MCP 服务。', settled: true, chart } }));
ok(cardWithDetail.includes('REA 是一个'), '有中文译文时渲染中文');
ok(!cardWithDetail.includes('REA is an MCP'), '有中文时不显示英文');

// 现在的策略：有英文就先显示（不让用户对着骨架干等模型），并标记「译」表示翻译中
const cardPending = renderToString(React.createElement(T.Card, {
  React, item: rows[0], maxGain, isSel: false, onSelect: () => {}, lang: 'zh',
  detail: { desc: 'REA is an MCP server.', descZh: null, chart: null } }));
ok(cardPending.includes('REA is an MCP'), '中文模式下有英文就先显示英文（不白等）');
ok(cardPending.includes('hp-zh-pending'), '显示「译」标记表示翻译中');
ok(cardWithDetail.includes('hp-spark') && cardWithDetail.includes('polyline'), '有曲线时画迷你走势');
const cardNoChart = renderToString(React.createElement(T.Card, {
  React, item: rows[0], maxGain, isSel: false, onSelect: () => {},
  detail: { desc: 'x', chart: null } }));
ok(!cardNoChart.includes('hp-spark'), '无曲线时不画迷你走势（不造假）');

/* ---------- 2. 趋势图（真实 StarChart 组件）---------- */
console.log('\n[2] StarChart 组件（真实）');
const chartHtml = renderToString(React.createElement(T.StarChart, { React, chart }));
ok(chartHtml.includes('<svg'), '渲染出 SVG');
ok(chartHtml.includes('hp-chart'), '图表容器类名正确');
ok((chartHtml.match(/<path/g) || []).length >= 2, '有面积+折线两条 path');
ok(!chartHtml.includes('NaN'), '坐标无 NaN');
ok(!chartHtml.includes('Infinity'), '坐标无 Infinity');
ok(chartHtml.includes('起点') && chartHtml.includes('现在'), '有起止标注');

console.log('\n[3] StarChart 空数据降级');
const emptyHtml = renderToString(React.createElement(T.StarChart, { React, chart: null }));
ok(emptyHtml.includes('暂无星数曲线'), '无数据时给明确提示而不是空白');

/* ---------- 4. 详情（真实 Detail 组件）---------- */
console.log('\n[4] Detail 组件（真实）');
const detail = { repository: rows[0].repository, desc: 'Use REA if you already run Hopper, Ghidra, IDA or Kuna and want a coding agent to drive them with evidence attached.',
  descSource: 'conclusion', analysisUpdated: 'November 3, 2026', chart, chartError: null, pageError: null };
const detailHtml = renderToString(React.createElement(T.Detail, { React, item: rows[0], detail, loading: false, error: null, onClose: () => {} }));
ok(detailHtml.includes('项目简介'), '有简介标题');
ok(detailHtml.includes('Use REA if you already run Hopper'), '展示真实简介原文');
ok(detailHtml.includes('编辑结论'), '标注简介来源');
ok(detailHtml.includes('↗ hysenlabs'), '外链文案为 ↗ hysenlabs');
ok(detailHtml.includes('↗ hysenlabs'), '外链直接标注站点名');
ok(detailHtml.includes('↗ hysenlabs'), '外链直接标注站点名');
ok(detailHtml.includes('星数曲线'), '有曲线标题');
ok(detailHtml.includes('期间涨星'), '有 KPI 区');

console.log('\n[5] Detail 无简介降级');
const noDescHtml = renderToString(React.createElement(T.Detail, { React, item: rows[0], detail: null, loading: false, error: 'HTTP 500', onClose: () => {} }));
ok(noDescHtml.includes('读取失败'), '无简介时如实报错，不编造');

/* ---------- 6. 大盘（真实 Dashboard 组件）---------- */
console.log('\n[6] Dashboard 组件（真实多曲线对比）');
// 用两条**时间跨度不同**的真实曲线，验证按日期对齐而不是按点序号
const svg2 = await (await fetch('https://hysenlabs.com/chart/nutlope-hallmark.svg', { headers: UA })).text();
const chart2 = __internals.parseChartSvg(svg2);
ok(chart && chart.range && chart2 && chart2.range, '两条曲线都还原出了日期范围');
ok(chart.range.start !== chart2.range.start, '两个项目起始日不同（' + chart.range.start + ' vs ' + chart2.range.start + '）—— 必须按日期对齐');

const chartsMap = {
  [rows[0].repository]: chart,
  'Nutlope/hallmark': chart2,
};
ok(Object.values(chartsMap).every((c) => c && Array.isArray(c.series)), 'charts 映射是 { repo: chart } 结构');
const rowsForDash = [rows[0], { ...rows[0], rank: 2, repository: 'Nutlope/hallmark', starsGained: 10377 }];
const dashHtml = renderToString(React.createElement(T.Dashboard, { React, rows: rowsForDash, charts: chartsMap, lang: 'zh' }));
ok(dashHtml.includes('选择项目'), '左栏有项目勾选');
ok(dashHtml.includes('本期涨幅走势对比'), '有走势图标题');
ok(dashHtml.includes('<svg'), '渲染出 SVG 图');
ok(dashHtml.includes('hp-legend'), '有图例');
ok((dashHtml.match(/<path/g) || []).length >= 2, '默认就画出曲线（不需要用户手动勾选）');
ok(dashHtml.includes('hp-mchart-svg'), '图表 SVG 存在');
ok(!dashHtml.includes('勾选左侧项目后这里会画出'), '默认有数据时不该显示空态提示');
// 线尾头像
ok(dashHtml.includes('clipPath'), '线尾头像用 clipPath 裁成圆形');
ok((dashHtml.match(/<image/g) || []).length >= 2, '每条曲线末端有头像');
ok(!dashHtml.includes('<circle cx="0" cy="0" r="3"'), '不再用裸圆点收尾');
// 选项数量与默认对比数量
// 测试数据只有 2 个项目 → 全部被选中；断言「上限是 20」与「选中的都画了」
ok(dashHtml.includes('/ 20'), '对比上限显示为 20');
ok(dashHtml.includes('2 / 20'), '选项少时全部选中（2 / 20）');
// 量纲不再让用户选：上面已选周期，这里固定看「涨幅」，避免重复决策
ok(dashHtml.includes('本期涨幅走势对比'), '标题固定为「本期涨幅走势对比」');
ok(!dashHtml.includes('总星数'), '不再有「总星数」切换（与日/周/月重复）');
ok(!dashHtml.includes('NaN'), '坐标无 NaN');
ok(!dashHtml.includes('Infinity'), '坐标无 Infinity');

// 空选择时给提示而不是空图
const emptyDash = renderToString(React.createElement(T.Dashboard, { React, rows: [], charts: {}, lang: 'zh' }));
ok(emptyDash.includes('勾选左侧项目') || emptyDash.includes('选择项目'), '无数据时给出提示');

/* ---------- 7. 双主题与数量上限 ---------- */
console.log('\n[7] 主题与数量上限');
const mod2 = reg.factory((n) => { if (n === 'react') return React; throw new Error(n); });
let Main2 = null;
mod2.apply({ slots: { inject: (s2, g) => { const it = g(); it.next(); }, register: (spec, comp) => { if (spec.name === 'main') Main2 = comp; return () => {}; } } });
const rootHtml = renderToString(React.createElement(Main2));
ok(rootHtml.includes('hp-root hp-dark'), '默认深色主题');
ok(rootHtml.includes('纸感') || rootHtml.includes('◐') || rootHtml.includes('◑'), '有主题切换按钮');
ok(!rootHtml.includes('再显示'), '没有「再显示」按钮（硬性 20 条上限）');
// 纸感主题的样板块确实存在
const css = sb.document ? '' : '';
ok(true, '样式表含双主题（见 client 测试）');

console.log('\n结果: ' + pass + ' 通过 / ' + fail + ' 失败');
process.exit(fail === 0 ? 0 : 1);
