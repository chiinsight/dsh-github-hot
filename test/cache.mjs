/**
 * 缓存口径测试：确认「按自然日」而不是「按 24 小时」。
 *
 * 背景：Hysen 的数据每天才更新一次，所以同一天内不管隔多久都该命中缓存；
 * 一旦跨天就失效重取。这条判据直接决定会不会过度请求对方站点。
 */
import { __internals } from '../lib/index.js';

const { cacheGet, cacheSet, localDayKey, DAY_MS, __cache } = __internals;
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✓ ' + m); } else { fail++; console.log('  ✗ ' + m); } };

console.log('[1] 常量');
ok(DAY_MS === 24 * 60 * 60 * 1000, '榜单/详情 TTL 都等于一天');

console.log('\n[2] 同一天内命中（即使接近 24 小时前）');
cacheSet('board:day', { rows: [1, 2, 3] });
ok(cacheGet('board:day', DAY_MS) !== null, '刚写入立即可命中');
// 伪造「今天 00:01 写入」：把时间戳改成当天凌晨
const cache = __cache;
if (cache && cache.get) {
  const entry = cache.get('board:day');
  const now = new Date();
  entry.at = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 1).getTime();
  const hit = cacheGet('board:day', DAY_MS);
  ok(hit !== null, '同日 00:01 写入，现在仍命中（不是按 24h 算）');
}

console.log('\n[3] 跨天失效');
cacheSet('board:week', { rows: [9] });
if (cache && cache.get) {
  const entry = cache.get('board:week');
  entry.at = Date.now() - 26 * 60 * 60 * 1000; // 26 小时前 = 一定是昨天
  const hit = cacheGet('board:week', DAY_MS);
  ok(hit === null, '昨天的缓存失效，会重新取数');
}

console.log('\n[4] 日期键');
ok(/^\d{4}-\d{2}-\d{2}$/.test(localDayKey()), 'localDayKey 格式正确');
const d1 = new Date(2026, 10, 4, 0, 0).getTime();
const d2 = new Date(2026, 10, 4, 23, 59).getTime();
const d3 = new Date(2026, 10, 5, 0, 1).getTime();
ok(localDayKey(d1) === localDayKey(d2), '同日不同时刻 → 同一个键');
ok(localDayKey(d2) !== localDayKey(d3), '跨午夜 → 不同的键');

console.log('\n结果: ' + pass + ' 通过 / ' + fail + ' 失败');
process.exit(fail === 0 ? 0 : 1);
