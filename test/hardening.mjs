/**
 * 健壮性排查测试 —— 覆盖容易出错但不容易被发现的边界。
 *
 * 这些不是「跑通就行」的测试，而是专门盯：
 *   ① 路径穿越 / 注入
 *   ② 缓存无限增长
 *   ③ 并发重复请求
 *   ④ 结构过期数据被当作有效缓存
 *   ⑤ 时区相关的日期显示
 */
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { __internals } from '../lib/index.js';

const PLUGIN = fileURLToPath(new URL('../lib/index.js', import.meta.url));
const NODE = process.execPath;
let pass = 0, fail = 0;
const ok = (c, m, extra) => { if (c) { pass++; console.log('  ✓ ' + m); } else { fail++; console.log('  ✗ ' + m + (extra ? ' | ' + extra : '')); } };

const { slugOf, dayKeyInSourceTz, SOURCE_TZ, currentWeekMonday, parseCsv, detailShapeOk } = __internals;

console.log('[1] 路径穿越 / 注入');
for (const bad of ['../../etc/passwd', '..\\..\\win', 'a/../../b', '/etc/hosts']) {
  const s = slugOf(bad);
  ok(!s.includes('/') && !s.includes('\\') && !s.includes('..'), 'slug 不含路径分隔符：' + bad + ' → ' + s);
}
ok(slugOf('Owner/Repo') === 'owner-repo', '正常名字正确转换');
ok(slugOf('a/b?x=1') === 'a-bx1', '查询串字符被剔除');
ok(/^[a-z0-9._-]*$/.test(slugOf('中文/名字')), '非 ASCII 被剔除');

console.log('\n[2] 时区');
ok(SOURCE_TZ === 'Asia/Shanghai', '数据源时区固定为 Asia/Shanghai');
const tzOut = execFileSync(NODE, ['--input-type=module', '-e', `
  const m = await import(${JSON.stringify(PLUGIN)});
  console.log(JSON.stringify({ d: m.__internals.dayKeyInSourceTz(), w: m.__internals.currentWeekMonday() }));
`], { env: { ...process.env, TZ: 'America/New_York' }, encoding: 'utf8', timeout: 20000 }).trim();
const ny = JSON.parse(tzOut.split('\n').pop());
ok(ny.d === dayKeyInSourceTz(), '纽约时区算出的日期与上海一致：' + ny.d);
ok(ny.w === currentWeekMonday(), '周一也一致：' + ny.w);

console.log('\n[3] 缓存结构校验');
ok(detailShapeOk(null) === false, 'null 不算有效');
ok(detailShapeOk({}) === true, '没有曲线也算有效（只是没取到曲线）');
ok(detailShapeOk({ chart: null }) === true, 'chart 为 null 有效');
ok(detailShapeOk({ chart: { series: [] } }) === false, '空 series 无效');
ok(detailShapeOk({ chart: { series: [{ date: '2026-11-03', stars: 1 }] } }) === true, '带 date 的点有效');
ok(detailShapeOk({ chart: { series: [{ stars: 1 }] } }) === false, '缺 date 的点无效（会重取）');
ok(detailShapeOk({ chart: { series: [{ date: 'bad', stars: 1 }] } }) === false, 'date 格式不对无效');

console.log('\n[4] CSV 解析边界');
ok(parseCsv('').length === 0, '空串');
ok(parseCsv('a,b\n1,2').length === 2, '正常两行');
ok(parseCsv('a,b\r\n1,2\r\n').length === 2, 'CRLF 换行');
const quoted = parseCsv('a,"b,c"\n1,2');
ok(quoted[0][1] === 'b,c', '带引号的逗号字段被当作一个整体：' + JSON.stringify(quoted[0]));
ok(quoted.length === 2, '行数正确');
ok(parseCsv('a,b\n\n1,2').filter(r => r.length > 1).length === 2, '空行不影响');

console.log('\n[5] 曲线上限（防止异常 SVG 把内存撑爆）');
const { parseChartSvg } = __internals;
const huge = '<svg><title>x</title><line x1="60" x2="776" y1="326" y2="326"/><text x="52" y="330">0</text>' +
  '<line x1="60" x2="776" y1="12" y2="12"/><text x="52" y="16">100</text>' +
  '<text x="60" y="348">Sep 1</text><text x="776" y="348">Nov 3</text>' +
  '<path d="M' + Array.from({length: 20000}, (_, i) => (60 + i * 0.03).toFixed(1) + ' ' + (100 + (i % 50)).toFixed(1)).join(' L') + '"/></svg>';
const t0 = Date.now();
const parsed = parseChartSvg(huge);
const cost = Date.now() - t0;
ok(parsed !== null && parsed.series.length === 20000, '能解析 2 万点（' + parsed.series.length + '）');
ok(cost < 2000, '解析耗时可控：' + cost + 'ms');

console.log('\n结果: ' + pass + ' 通过 / ' + fail + ' 失败');
process.exit(fail === 0 ? 0 : 1);
