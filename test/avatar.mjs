/**
 * 头像链路测试：
 *   ① 能从 Hysen 项目页里抠出 CDN 直链（**不经过 github.com 重定向**）
 *   ② 直链能下载到真实图片（不是 70B 占位图）
 *   ③ 头像会写进磁盘缓存，重启后不用重下
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, existsSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { __internals } from '../lib/index.js';

let pass = 0, fail = 0;
const ok = (c, m, extra) => { if (c) { pass++; console.log('  ✓ ' + m); } else { fail++; console.log('  ✗ ' + m + (extra ? ' | ' + extra : '')); } };
const UA = { 'User-Agent': 'dsh-hysen-pulse/test' };

console.log('[1] 从 Hysen 页面抠 CDN 直链');
const html = await (await fetch('https://hysenlabs.com/projects/morluto-rea', { headers: UA })).text();
const url = __internals.parseAvatarUrl(html);
ok(url !== null, '抠到了地址');
ok(url && url.startsWith('https://avatars.githubusercontent.com/u/'), '是 CDN 直链（不经 github.com）：' + url);
ok(url && !url.includes('github.com/morluto'), '不是需要重定向的 github.com/{owner}.png');
ok(__internals.parseAvatarUrl('<html>没有头像</html>') === null, '没有头像时返回 null，不硬编');

console.log('\n[2] 直链能下到真图');
const r = await fetch(url, { headers: UA, redirect: 'follow' });
const buf = Buffer.from(await r.arrayBuffer());
ok(r.ok, 'HTTP ' + r.status);
ok((r.headers.get('content-type') || '').startsWith('image/'), '是图片类型：' + r.headers.get('content-type'));
ok(buf.length > 500, '体积正常（' + buf.length + 'B，不是占位图）');
ok(buf[0] === 0xff && buf[1] === 0xd8, '确实是 JPEG');

console.log('\n[3] 头像落盘（重启后复用）');
const home = mkdtempSync(join(tmpdir(), 'hp-av-'));
const env = { ...process.env, DSH_HOME: home };
const NODE = process.execPath;
const PLUGIN = new URL('../lib/index.js', import.meta.url).href;

// 进程 A：取一张头像 → 应写盘
execFileSync(NODE, ['--input-type=module', '-e', `
  const mod = await import(${JSON.stringify(PLUGIN)});
  const entry = await mod.__internals.fetchAvatar('morluto', ${JSON.stringify(url)});
  console.log('got', entry.body.length);
`], { env, encoding: 'utf8', timeout: 60000 });

const avDir = join(home, 'dsh-github-hot', 'avatars');
ok(existsSync(avDir), '头像目录已创建');
const files = existsSync(avDir) ? readdirSync(avDir) : [];
ok(files.includes('morluto.json'), '头像写成 morluto.json：' + files.join(','));
if (files.includes('morluto.json')) {
  const saved = JSON.parse(readFileSync(join(avDir, 'morluto.json'), 'utf8'));
  ok(typeof saved.body === 'string' && saved.body.length > 500, '磁盘里存了图片字节（base64）');
  ok(typeof saved.type === 'string' && saved.type.startsWith('image/'), '磁盘里存了类型：' + saved.type);
}

// 进程 B：断网也能读出来（模拟重启 + 网络故障）
const out = execFileSync(NODE, ['--input-type=module', '-e', `
  const mod = await import(${JSON.stringify(PLUGIN)});
  const entry = await mod.__internals.fetchAvatar('morluto', null);
  console.log('len', entry.body.length);
`], { env, encoding: 'utf8', timeout: 60000 }).trim();
ok(out.includes('len'), '重启后仍能取到头像：' + out.split('\n').pop());

rmSync(home, { recursive: true, force: true });
console.log('\n结果: ' + pass + ' 通过 / ' + fail + ' 失败');
process.exit(fail === 0 ? 0 : 1);
