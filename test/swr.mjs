/**
 * 跨天加载行为测试 —— 这是用户真实踩到的严重问题：
 *
 *   新的一天首次打开，三个榜单的「当天缓存」全部失效，
 *   结果对着骨架干等 5~24 秒（周榜还要试 3 个候选周，每个 8 秒超时），
 *   而且失败后不写缓存 → 每次打开都重新抓 → 「明明刚加载过，再点又卡半天」。
 *
 * 现在的要求：
 *   ① 有历史缓存时**立刻返回旧数据**（stale），后台再抓新的；
 *   ② 抓失败的榜单要**退避 5 分钟**，不能每次请求都重试；
 *   ③ refreshing 只在真的派了刷新任务时为 true（否则前端会每 8 秒空转）。
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const home = mkdtempSync(join(tmpdir(), 'dsh-swr-'));
process.env.DSH_HOME = home;
const { __internals: I } = await import('../lib/index.js');
const originalFetch = globalThis.fetch;
test.after(() => { globalThis.fetch = originalFetch; rmSync(home, { recursive: true, force: true }); });

const DAY = 24 * 60 * 60 * 1000;

async function get(url, ctx = {}) {
  let status, body;
  const t0 = Date.now();
  await I.handleRoute(ctx, { method: 'GET', url }, {
    writeHead: (code) => { status = code; }, end: (data) => { body = JSON.parse(data); },
  });
  assert.equal(status, 200, JSON.stringify(body));
  return { body, ms: Date.now() - t0 };
}
const boards = (ctx) => get('/dsh-github-hot/boards', ctx);

/** 造一份「昨天抓到的」榜单缓存。 */
function seedStaleBoards() {
  const rows = Array.from({ length: 3 }, (_, i) => ({ rank: i + 1, repository: 'o/r' + i, starsGained: 100 - i }));
  for (const [id, label] of [['day', '日榜'], ['week', '周榜'], ['month', '月榜']]) {
    I.__cache.set('board:' + id, {
      at: Date.now() - 2 * DAY, // 两天前 → 跨天失效
      value: { id, label, ok: true, fetchedAt: null, rows, window: { end: '2026-11-04' }, week: null, error: null },
    });
  }
}

test('跨天首次打开：立刻返回旧数据，不等网络', async () => {
  seedStaleBoards();
  // 网络全挂：如果实现是「等取数完成」，这个测试会等超时
  globalThis.fetch = async () => { throw new Error('network down'); };

  const { body, ms } = await boards();
  assert.ok(ms < 400, `必须秒回（实际 ${ms}ms）`);
  assert.equal(body.boards.length, 3);
  for (const b of body.boards) {
    assert.equal(b.stale, true, b.label + ' 应标记为过期数据');
    assert.equal((b.rows || []).length, 3, b.label + ' 应带回历史行');
  }
  assert.equal(body.refreshing, true, '后台应已发起刷新');
});

test('失败的榜单会退避，不会每次请求都重抓', async () => {
  let attempts = 0;
  globalThis.fetch = async () => { attempts += 1; throw new Error('boom'); };

  await boards();               // 第 1 次：触发刷新
  await new Promise((r) => setTimeout(r, 150)); // 等背景刷新失败落地
  const after1 = attempts;
  assert.ok(after1 >= 1, '第一次应尝试过刷新');

  await boards();               // 第 2 次
  await boards();               // 第 3 次
  await new Promise((r) => setTimeout(r, 150));

  assert.equal(attempts, after1, '退避期内不应再发请求');
  const { body } = await boards();
  assert.equal(body.refreshing, false, '退避中 refreshing 应为 false（避免前端空转）');
  // 退避期间仍然要有数据可显示
  assert.equal((body.boards[0].rows || []).length, 3, '退避时仍返回旧数据');
});


test('跨天的详情同样秒回旧数据（列表页一次要取 6~20 个，慢起来更致命）', async () => {
  const slug = 'o-x';
  I.__cache.set('detail:' + slug, {
    at: Date.now() - 2 * DAY, // 跨天
    value: {
      repository: 'o/x', slug, pageUrl: '', avatarUrl: null,
      desc: '旧简介', descSource: 'overview', whatIsIt: '旧简介',
      glance: [{ q: 'What is it?', a: '旧的问答' }],
      analysisUpdated: null, chart: null, chartError: null, pageError: null, fetchedAt: null,
    },
  });
  globalThis.fetch = async () => { throw new Error('down'); };

  const { body, ms } = await get('/dsh-github-hot/detail?repo=o/x&translate=0');
  assert.ok(ms < 400, `详情要秒回（实际 ${ms}ms）`);
  assert.equal(body.detail.desc, '旧简介');
  assert.equal(body.detail.stale, true, '应标记为过期');
});

test('批量接口在跨天时也不会被逐个拖慢', async () => {
  const rows = [];
  for (let i = 0; i < 6; i += 1) {
    // 缓存键用的是 slugOf(repo)，不是随便起的名字
    const slug = I.slugOf('b/' + i);
    I.__cache.set('detail:' + slug, {
      at: Date.now() - 2 * DAY,
      value: {
        repository: 'b/' + i, slug, pageUrl: '', avatarUrl: null,
        desc: 'desc' + i, descSource: 'overview', whatIsIt: null,
        glance: [], analysisUpdated: null, chart: null, chartError: null, pageError: null, fetchedAt: null,
      },
    });
    rows.push('b/' + i);
  }
  globalThis.fetch = async () => { throw new Error('down'); };

  const { body, ms } = await get('/dsh-github-hot/batch?repos=' + rows.join(',') + '&translate=0');
  assert.ok(ms < 800, `6 个详情应秒回（实际 ${ms}ms）`);
  assert.equal(body.items.length, 6);
  assert.ok(body.items.every((it) => it.desc), '每个都应带回旧简介');
});
