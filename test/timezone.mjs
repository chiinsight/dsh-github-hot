/**
 * 时区测试 —— 这个插件最容易出隐蔽 bug 的地方。
 *
 * 数据源（Hysen Labs）按 **Asia/Shanghai** 切日/周/月窗口。如果代码用「用户本地时区」
 * 判断今天/本周，跨时区用户就会拿到错误的榜单，或者看到互相矛盾的「数据更新到 X 日」。
 *
 * 这里用子进程模拟不同时区（TZ 环境变量），验证结果**与运行机器时区无关**。
 */
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const PLUGIN = fileURLToPath(new URL('../lib/index.js', import.meta.url));
const NODE = process.execPath;
let pass = 0, fail = 0;
const ok = (c, m, extra) => { if (c) { pass++; console.log('  ✓ ' + m); } else { fail++; console.log('  ✗ ' + m + (extra ? ' | ' + extra : '')); } };

function run(tz, code) {
  const out = execFileSync(NODE, ['--input-type=module', '-e', `
    const m = await import(${JSON.stringify(PLUGIN)});
    const T = m.__internals;
    ${code}
  `], { env: { ...process.env, TZ: tz }, encoding: 'utf8', timeout: 30000 }).trim();
  return JSON.parse(out.split('\n').pop());
}

console.log('[1] 同一个时刻，在不同时区算出的「数据源今天」必须一致');
const zones = ['Asia/Shanghai', 'America/Los_Angeles', 'UTC', 'Europe/London', 'Pacific/Auckland'];
const days = zones.map((tz) => run(tz, `console.log(JSON.stringify({ d: T.dayKeyInSourceTz() }));`).d);
ok(new Set(days).size === 1, '五个时区结果一致：' + days[0]);
ok(/^\d{4}-\d{2}-\d{2}$/.test(days[0]), '格式为 YYYY-MM-DD：' + days[0]);

console.log('\n[2] 指定时刻时，各时区也一致（不随本地时区漂移）');
// 2026-11-04 00:30 UTC = 北京 08:30 → 数据源「今天」应为 11-04
const ts = Date.UTC(2026, 10, 3, 16, 30); // 2026-11-03 16:30 UTC = 11-04 00:30 北京
const same = zones.map((tz) => run(tz, `console.log(JSON.stringify({ d: T.dayKeyInSourceTz(${ts}) }));`).d);
ok(new Set(same).size === 1, '各时区一致：' + same[0]);
ok(same[0] === '2026-11-04', 'UTC 16:30 在北京已是次日 11-04（得到 ' + same[0] + '）');

console.log('\n[3] 周一的算法跨时区一致');
const mondays = zones.map((tz) => run(tz, `console.log(JSON.stringify({ w: T.currentWeekMonday() }));`).w);
ok(new Set(mondays).size === 1, '各时区算出同一个周一：' + mondays[0]);
ok(/^\d{4}-\d{2}-\d{2}$/.test(mondays[0]), '格式正确');
{
  // 必须是真正的周一
  const [y, m, d] = mondays[0].split('-').map(Number);
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  ok(dow === 1, '确实是周一（getUTCDay=' + dow + '）');
}

console.log('\n[4] 时区常量正确');
const tz = run('UTC', `console.log(JSON.stringify({ tz: T.SOURCE_TZ }));`).tz;
ok(tz === 'Asia/Shanghai', '数据源时区 = Asia/Shanghai（与 Hysen 周榜口径一致）');

console.log('\n[5] 跨年边界');
{
  // 2026-12-31 16:00 UTC = 2027-01-01 00:00 北京
  const nyTs = Date.UTC(2026, 11, 31, 16, 0);
  const r = zones.map((t) => run(t, `console.log(JSON.stringify({ d: T.dayKeyInSourceTz(${nyTs}) }));`).d);
  ok(new Set(r).size === 1 && r[0] === '2027-01-01', '北京跨年后正确显示 2027-01-01（得到 ' + r[0] + '）');
}

console.log('\n结果: ' + pass + ' 通过 / ' + fail + ' 失败');
process.exit(fail === 0 ? 0 : 1);
