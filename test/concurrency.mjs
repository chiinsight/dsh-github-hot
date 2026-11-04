/**
 * 出网调度测试。
 *
 * 背景：早期用「单条全局串行队列」，一个批次取 20 个项目会把其它请求全堵住，
 * 一个批次取 20 个项目时，后进来的请求会被全部阻塞。现在按 host 分队列 + 限并发。
 *
 * 这里不联网，直接验证并发行为本身。
 */
import { fileURLToPath } from 'node:url';

const CLIENT = fileURLToPath(new URL('../lib/client.js', import.meta.url));
let pass = 0, fail = 0;
const ok = (c, m, extra) => { if (c) { pass++; console.log('  ✓ ' + m); } else { fail++; console.log('  ✗ ' + m + (extra ? ' | ' + extra : '')); } };

// 从 index.js 里把调度器源码抽出来单独跑（避免 import 整个插件、触发真实网络）
import { readFileSync } from 'node:fs';
const src = readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8');
const start = src.indexOf('const HOST_CONCURRENCY = 4;');
const end = src.indexOf('async function fetchText(');
const scheduler = src.slice(start, end);

const factory = new Function('URL', scheduler + '\nreturn { runOnHost, hostOf, hostState, HOST_CONCURRENCY };');
const { runOnHost, hostOf, hostState, HOST_CONCURRENCY } = factory(URL);

console.log('[1] 基础并发');
ok(HOST_CONCURRENCY >= 2, '并发上限 >= 2（当前 ' + HOST_CONCURRENCY + '）');
ok(hostOf('https://hysenlabs.com/a/b') === 'hysenlabs.com', 'host 提取正确');
ok(hostOf('not a url') === 'unknown', '非法 URL 不抛错');

console.log('\n[2] 同一 host 限并发');
{
  hostState.clear();
  let peak = 0;
  let active = 0;
  const tasks = Array.from({ length: 12 }, () =>
    runOnHost('slow.test', async () => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 30));
      active -= 1;
    }),
  );
  await Promise.all(tasks);
  ok(peak <= HOST_CONCURRENCY, '峰值并发不超过上限（' + peak + ' <= ' + HOST_CONCURRENCY + '）');
  ok(peak >= 2, '确实并发了（峰值 ' + peak + '）');
  ok(hostState.get('slow.test').active === 0, '全部完成后在途归零');
}

console.log('\n[3] 不同 host 互不阻塞（关键：这正是之前 15 秒的根因）');
{
  hostState.clear();
  const order = [];
  // slow host 塞 8 个慢任务
  const slow = Array.from({ length: 8 }, (_, i) =>
    runOnHost('a.test', async () => {
      await new Promise((r) => setTimeout(r, 100));
      order.push('a' + i);
    }),
  );
  // 另一个 host 一个快任务，应该立刻跑完，不被 a.test 排队拖住
  const t0 = Date.now();
  await runOnHost('b.test', async () => {
    await new Promise((r) => setTimeout(r, 10));
    order.push('b');
  });
  const fastCost = Date.now() - t0;
  ok(fastCost < 80, 'b.test 未被 a.test 拖慢（' + fastCost + 'ms）');
  ok(order.includes('b'), 'b 已完成');
  ok(!order.includes('a0'), '此时 a.test 还没跑完（证明确实并行）');
  await Promise.all(slow);
}

console.log('\n[4] 任务失败不会卡死队列');
{
  hostState.clear();
  const bad = runOnHost('err.test', async () => { throw new Error('boom'); }).catch(() => 'caught');
  const good = runOnHost('err.test', async () => 'ok');
  ok((await bad) === 'caught', '失败被捕获');
  ok((await good) === 'ok', '后续任务照常执行');
  ok(hostState.get('err.test').active === 0, '在途计数归零');
}

console.log('\n结果: ' + pass + ' 通过 / ' + fail + ' 失败');
process.exit(fail === 0 ? 0 : 1);
