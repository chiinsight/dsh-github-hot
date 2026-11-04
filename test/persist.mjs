/**
 * 磁盘缓存测试：验证缓存能跨「进程重启」复用。
 *
 * 做法：起两个独立的 node 进程（模拟重启），第一个写入缓存，第二个读出来。
 * 用临时 DSH_HOME，不污染真实环境。
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const NODE = process.execPath;
const PLUGIN = new URL('../lib/index.js', import.meta.url).href;
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✓ ' + m); } else { fail++; console.log('  ✗ ' + m); } };

const home = mkdtempSync(join(tmpdir(), 'hp-cache-'));
const env = { ...process.env, DSH_HOME: home };

console.log('临时 DSH_HOME:', home);

console.log('\n[1] 进程 A 写入缓存');
const writeOut = execFileSync(NODE, ['--input-type=module', '-e', `
  const { __internals } = await import(${JSON.stringify(PLUGIN)});
  __internals.cacheSet('board:day', { rows: [{ repository: 'a/b', starsGained: 42 }] });
  __internals.cacheSet('board:week', { rows: [{ repository: 'c/d', starsGained: 7 }] });
  // 等节流落盘（3 秒）后退出
  await new Promise(r => setTimeout(r, 4000));
  console.log('written');
`], { env, encoding: 'utf8', timeout: 30000 });
ok(writeOut.includes('written'), '进程 A 正常结束');
const dir = join(home, 'dsh-github-hot');
ok(existsSync(dir), '缓存目录已创建：' + (existsSync(dir) ? readdirSync(dir).join(', ') : '无'));
ok(existsSync(join(dir, 'cache.json')), 'cache.json 已落盘');

console.log('\n[2] 进程 B 读取（模拟重启）');
const readOut = execFileSync(NODE, ['--input-type=module', '-e', `
  const { __internals } = await import(${JSON.stringify(PLUGIN)});
  const { cacheGet, DAY_MS } = __internals;
  const hit = cacheGet('board:day', DAY_MS);
  console.log(JSON.stringify({ hit }));
`], { env, encoding: 'utf8', timeout: 30000 }).trim();
const parsed = JSON.parse(readOut.split('\n').pop());
ok(parsed.hit !== null, '重启后仍能命中磁盘缓存');
ok(parsed.hit && parsed.hit.rows && parsed.hit.rows[0].repository === 'a/b', '缓存内容完整（a/b）');
ok(parsed.hit && parsed.hit.rows[0].starsGained === 42, '数值未被破坏（42）');

console.log('\n[3] 损坏的缓存文件不会拖垮插件');
execFileSync(NODE, ['-e', `require('fs').writeFileSync(${JSON.stringify(join(dir, 'cache.json'))}, 'THIS IS NOT JSON{{{')`]);
const recoverOut = execFileSync(NODE, ['--input-type=module', '-e', `
  const { __internals } = await import(${JSON.stringify(PLUGIN)});
  const hit = __internals.cacheGet('board:day', __internals.DAY_MS);
  __internals.cacheSet('x', { ok: 1 });
  console.log(JSON.stringify({ hit, survived: true }));
`], { env, encoding: 'utf8', timeout: 30000 }).trim();
const rec = JSON.parse(recoverOut.split('\n').pop());
ok(rec.survived === true, '文件损坏时插件照常工作');
ok(rec.hit === null, '损坏文件被当作空缓存（不返回脏数据）');

rmSync(home, { recursive: true, force: true });
console.log('\n结果: ' + pass + ' 通过 / ' + fail + ' 失败');
process.exit(fail === 0 ? 0 : 1);
