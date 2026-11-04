import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
// 直接抽出 smoothPath 做单元验证
const src = readFileSync(fileURLToPath(new URL('../lib/client.js', import.meta.url)),'utf8');
const fn = src.match(/function smoothPath\(points\) \{[\s\S]*?\n  \}/)[0];
const smoothPath = new Function('return ' + fn)();

let pass=0, fail=0;
const ok=(c,m,x)=>{ if(c){pass++;console.log('  ✓ '+m);} else {fail++;console.log('  ✗ '+m+(x?' | '+x:''));} };

console.log('[1] 基本形状');
const p = [[0,100],[50,80],[100,40],[150,10]];
const d = smoothPath(p);
ok(d.startsWith('M0 100'), '从首点开始');
ok(!d.includes('NaN'), '无 NaN');
ok(/C/.test(d), '用了贝塞尔（C）而不是直线 L');

console.log('\n[2] 边界情况');
ok(smoothPath([]) === '', '空数组返回空串');
ok(smoothPath([[1,2]]) === 'M1 2', '单点');
ok(smoothPath([[1,2],[3,4]]) === 'M1 2 L3 4', '两点用直线');

console.log('\n[3] 过冲检查（平滑不应把曲线甩出数据范围太多）');
const steep = [[0,100],[10,100],[20,10],[30,10]];
const d2 = smoothPath(steep);
const nums = (d2.match(/-?\d+\.?\d*/g)||[]).map(Number);
const ys = nums.filter((_,i)=>i%2===1);
console.log('   y 值范围:', Math.min(...ys).toFixed(1), '~', Math.max(...ys).toFixed(1), '(数据 10~100)');
ok(Math.min(...ys) > -50 && Math.max(...ys) < 250, '没有严重过冲');

console.log('\n结果: '+pass+' 通过 / '+fail+' 失败');
process.exit(fail===0?0:1);
