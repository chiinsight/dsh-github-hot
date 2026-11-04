/**
 * 译文缓存读写一致性测试。
 *
 * 曾经的 bug：zhCacheSet 存纯字符串，zhCacheGet 却按 {zh} 对象取，
 * 导致译文缓存**只写不读** —— 每条都重新调模型，用户感觉「完全没缓存」。
 */
import { __internals } from '../lib/index.js';

const { zhCacheGet, zhCacheSet, flushZhNow } = __internals;
let pass = 0, fail = 0;
const ok = (c, m, x) => { if (c) { pass++; console.log('  ✓ ' + m); } else { fail++; console.log('  ✗ ' + m + (x ? ' | ' + x : '')); } };

console.log('[1] 基本读写往返');
const key = 'test-' + Date.now();
ok(zhCacheGet(key) === null, '未写入时返回 null');
zhCacheSet(key, '中文测试');
ok(zhCacheGet(key) === '中文测试', '写入后能读回（关键回归）', String(zhCacheGet(key)));

console.log('\n[2] 多条目不串味');
const keys = ['a-' + Date.now(), 'b-' + Date.now(), 'c-' + Date.now()];
keys.forEach((k, i) => zhCacheSet(k, '译文' + i));
ok(zhCacheGet(keys[0]) === '译文0', '第 1 条正确');
ok(zhCacheGet(keys[1]) === '译文1', '第 2 条正确');
ok(zhCacheGet(keys[2]) === '译文2', '第 3 条正确');

console.log('\n[3] 落盘');
ok(flushZhNow() === true, 'flushZhNow 返回成功');

console.log('\n[4] 空值处理');
zhCacheSet(key + '-empty', '');
ok(zhCacheGet(key + '-empty') === null, '空译文当作没有（不让界面显示空白）');

console.log('\n结果: ' + pass + ' 通过 / ' + fail + ' 失败');
process.exit(fail === 0 ? 0 : 1);
