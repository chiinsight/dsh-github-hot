/** 用真实线上数据验证三个解析器（会真的访问 hysenlabs.com）。 */
import { __internals } from '../lib/index.js';

const { parseCsv, parseWeeklyHtml, parseChartSvg, slugOf, currentWeekMonday } = __internals;
const UA = { 'User-Agent': 'dsh-hysen-pulse/test' };
let pass = 0, fail = 0;
const ok = (cond, msg, extra) => { if (cond) { pass++; console.log('  ✓ ' + msg); } else { fail++; console.log('  ✗ ' + msg + (extra ? ' | ' + extra : '')); } };

const get = async (u) => (await fetch(u, { headers: UA })).text();

// ---- 1. CSV ----
console.log('\n[1] 日榜 CSV');
const csv = await get('https://hysenlabs.com/data/star-growth-24h.csv');
const table = parseCsv(csv);
ok(table.length > 100, 'CSV 行数 = ' + table.length);
const header = table[0];
ok(header.includes('stars_gained') && header.includes('repository'), 'CSV 表头完整');
const row = {}; header.forEach((h, i) => row[h] = table[1][i]);
ok(row.repository.includes('/'), '首行仓库 = ' + row.repository);
ok(Number(row.stars_gained) > 0, '首行涨星 = ' + row.stars_gained);

// ---- 2. 周榜 HTML ----
console.log('\n[2] 周榜 HTML');
const weekMonday = currentWeekMonday();
console.log('  本周一 = ' + weekMonday);
let weeklyRows = null, usedWeek = null;
for (const w of [weekMonday, '2026-10-26', '2026-10-19']) {
  const html = await get('https://hysenlabs.com/weekly/' + w);
  const rows = parseWeeklyHtml(html);
  if (rows && rows.length > 0) { weeklyRows = rows; usedWeek = w; break; }
}
ok(weeklyRows !== null, '解析出周榜（用 ' + usedWeek + '）');
if (weeklyRows) {
  ok(weeklyRows.length === 10, '周榜 10 项');
  ok(weeklyRows[0].rank === 1 && weeklyRows[0].starsGained > 0, '第1名涨星 = ' + weeklyRows[0].starsGained);
  ok(weeklyRows.every(r => r.repository.includes('/')), '所有仓库名合法');
  ok(weeklyRows.every(r => r.slug && !r.slug.includes('/')), 'slug 合法');
  console.log('  前3:', weeklyRows.slice(0,3).map(r => r.repository + ' +' + r.starsGained).join(' | '));
}

// ---- 3. 曲线 SVG ----
console.log('\n[3] 星数曲线 SVG');
const svg = await get('https://hysenlabs.com/chart/morluto-rea.svg');
ok(svg.includes('<svg'), 'SVG 取回');
const chart = parseChartSvg(svg);
ok(chart !== null, '曲线解析成功');
if (chart) {
  ok(chart.series.length > 20, '数据点 = ' + chart.series.length);
  ok(chart.yTicks.length >= 2, 'y 轴刻度 = ' + chart.yTicks.length + ' 个');
  const first = chart.series[0].stars, last = chart.series[chart.series.length-1].stars;
  ok(last > first, '末尾星数 > 起始（' + Math.round(first) + ' → ' + Math.round(last) + '）');
  console.log('  x 轴:', chart.xLabels.map(l => l.label).join(' · '));
}

// ---- 4. slug ----
console.log('\n[4] 工具');
ok(slugOf('morluto/REA') === 'morluto-rea', 'slugOf 正确');

console.log('\n结果: ' + pass + ' 通过 / ' + fail + ' 失败');
process.exit(fail === 0 ? 0 : 1);
