import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
/** 数据日期显示：必须精确到年，且中英各自符合阅读习惯。 */
const src = readFileSync(fileURLToPath(new URL('../lib/client.js', import.meta.url)), 'utf8');

// 提取 dataDateText
const start = src.indexOf('  function dataDateText(board, lang) {');
let depth = 0, i = src.indexOf('{', start), end = -1;
for (; i < src.length; i++) {
  if (src[i] === '{') depth++;
  else if (src[i] === '}') { depth--; if (depth === 0) { end = i + 1; break; } }
}
const fnSrc = src.slice(start, end);
const dataDateText = new Function(fnSrc + '\nreturn dataDateText;')();

let pass = 0, fail = 0;
const ok = (c, m, x) => { if (c) { pass++; console.log('  ✓ ' + m); } else { fail++; console.log('  ✗ ' + m + (x ? ' → 实际: ' + x : '')); } };

console.log('[1] 中文：年月日');
const zhBoard = { window: { end: '2026-11-04' } };
ok(dataDateText(zhBoard, 'zh') === '26.11.4', '中文格式 26.11.4（紧凑两位年）', dataDateText(zhBoard,'zh'));

console.log('\n[2] 英文：月 日, 年');
ok(dataDateText(zhBoard, 'en') === 'Nov 4, 2026', '英文格式 Nov 4, 2026', dataDateText(zhBoard,'en'));

console.log('\n[3] 各月份英文缩写');
const months = [['2026-01-15','Jan 15, 2026'],['2026-06-01','Jun 1, 2026'],['2026-12-31','Dec 31, 2026']];
for (const [d, exp] of months) {
  ok(dataDateText({window:{end:d}}, 'en') === exp, d + ' → ' + exp, dataDateText({window:{end:d}},'en'));
}

console.log('\n[4] 边界情况');
ok(dataDateText(null, 'zh') === '今日', '空数据中文', dataDateText(null,'zh'));
ok(dataDateText(null, 'en') === 'today', '空数据英文', dataDateText(null,'en'));
ok(dataDateText({week:'2026-10-26'}, 'zh') === '26.10.26', '周榜用 week 字段', dataDateText({week:'2026-10-26'},'zh'));

ok(dataDateText({window:{end:'November 8, 2026'}}, 'zh') === '26.11.8', '周榜英文日期按真实窗口显示');
ok(dataDateText({window:{end:'November 8, 2026'}}, 'en') === 'Nov 8, 2026', '周榜英文日期格式');

console.log('\n[5] 不再省略年份（关键回归）');
const r = dataDateText(zhBoard, 'zh');
ok(r.startsWith('26.'), '中文含两位年份（26.xx.xx）', r);
ok(dataDateText(zhBoard, 'en').includes('2026'), '英文含年份');

console.log('\n结果: ' + pass + ' 通过 / ' + fail + ' 失败');
process.exit(fail === 0 ? 0 : 1);
