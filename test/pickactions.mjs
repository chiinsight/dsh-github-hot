/**
 * 统计页快捷选择按钮（前置 5 / 前 10 / 全选 / 清空）。
 *
 * 这里锁死两个曾经让「点了没反应」的真实 bug：
 *   ① 回调写成 props.onPickPreset —— 它其实是组件内的局部函数，props 上没有，
 *      点了直接 TypeError（被 React 吞掉，表现就是毫无反应）。
 *   ② 判断有没有曲线时写成 Array.isArray(charts[repo]) —— 但 charts[repo]
 *      是 { series: [...] } 对象，结果所有项目都被判成「没有曲线」，
 *      「全选/前10」选出一堆空集合，看着像没生效。
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const src = readFileSync(fileURLToPath(new URL('../lib/client.js', import.meta.url)), 'utf8');
let pass = 0, fail = 0;
const ok = (c, m, x) => { if (c) { pass++; console.log('  ✓ ' + m); } else { fail++; console.log('  ✗ ' + m + (x ? ' | ' + x : '')); } };

console.log('[1] 按钮存在且文案齐备');
ok(/hp-pick-actions/.test(src), '有快捷按钮行');
for (const [key, label] of [['stats.pickTop', '前 N'], ['stats.pickAll', '全选'], ['stats.pickClear', '清空']]) {
  ok(new RegExp("'" + key.replace('.', '\\.') + "'").test(src), '有 ' + label + ' 文案');
}
ok(/'stats\.pickTop': '前 \{n\}'/.test(src), '中文文案带占位符 {n}');

console.log('\n[2] 回调引用正确（回归 bug ①）');
ok(!/props\.onPickPreset/.test(src), '不再引用不存在的 props.onPickPreset');
ok(/const onPickPreset = React\.useCallback/.test(src), 'onPickPreset 是组件内局部函数');
for (const n of ['5', '10', 'MAX_COMPARE', '0']) {
  ok(new RegExp('onClick: \\(\\) => onPickPreset\\(' + n + (n === 'MAX_COMPARE' ? '' : '') + '\\)').test(src), '按钮传参 ' + n);
}

console.log('\n[3] 曲线判断正确（回归 bug ②）');
ok(/Array\.isArray\(c && c\.series\)/.test(src), '按 .series 判断是否真有曲线');
ok(!/const c = charts && charts\[r\.repository\];\s*\n\s*return Array\.isArray\(c\)/.test(src), '不再把 chart 对象当数组');

console.log('\n[4] 逻辑行为（用真实数据结构跑一遍）');
// 复刻 onPickPreset 的核心逻辑，输入用 chartMap 的真实形状 {series:[...]}
const MAX_COMPARE = 20;
function pickPreset(n, rows, charts) {
  if (!n || n <= 0) return new Set();
  const candidates = (rows || []).filter((r) => {
    const c = charts && charts[r.repository];
    return Array.isArray(c && c.series) && c.series.length > 0;
  });
  return new Set(candidates.slice(0, Math.min(n, MAX_COMPARE)).map((r) => r.repository));
}
const rows = Array.from({ length: 20 }, (_, i) => ({ repository: 'o/r' + i, rank: i + 1 }));
// 前 12 个有曲线，后 8 个没有（模拟真实情况：不是每个项目都有 SVG）
const charts = {};
rows.slice(0, 12).forEach((r) => { charts[r.repository] = { series: [{ date: '2026-11-01', stars: 1 }] }; });

ok(pickPreset(5, rows, charts).size === 5, '前 5 → 选中 5 个', String(pickPreset(5, rows, charts).size));
ok(pickPreset(10, rows, charts).size === 10, '前 10 → 选中 10 个', String(pickPreset(10, rows, charts).size));
ok(pickPreset(20, rows, charts).size === 12, '全选 → 只选有曲线的 12 个（不选空项目）', String(pickPreset(20, rows, charts).size));
ok(pickPreset(0, rows, charts).size === 0, '清空 → 0 个');
ok([...pickPreset(5, rows, charts)].every((x) => charts[x]), '选中的都有曲线');
ok(pickPreset(5, rows, charts).has('o/r0'), '前 5 从名次最前开始');

console.log('\n[5] 按钮禁用态 & 双主题');
ok(/disabled: picked\.size === 0/.test(src), '无选中时禁用清空');
ok(/\.hp-root\.hp-paper \.hp-pick-btn/.test(src), '纸感主题有独立样式');

console.log('\n结果: ' + pass + ' 通过 / ' + fail + ' 失败');
process.exit(fail === 0 ? 0 : 1);
