/**
 * 「新面孔」徽章测试。
 *
 * 判定依据：上游 CSV 的 rank_change_vs_day_ago 列为空 → 昨天不在榜 → 新面孔。
 * （一直在榜的项目会给 -1 / -2 这类数字）
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const home = mkdtempSync(join(tmpdir(), 'dsh-new-'));
process.env.DSH_HOME = home;
const { __internals: I } = await import('../lib/index.js');
const originalFetch = globalThis.fetch;
test.after(() => { globalThis.fetch = originalFetch; rmSync(home, { recursive: true, force: true }); });

const HEADER = 'rank,repository,github_url,hysenlabs_url,stars_gained,start_stars,end_stars,growth_pct,rank_change_vs_day_ago,language,license,window_start,window_end';
const csv = [
  HEADER,
  // 空 → 新面孔
  '1,o/brand-new,https://github.com/o/brand-new,https://hysenlabs.com/projects/o-brand-new,900,100,1000,800,,Rust,MIT,2026-11-04,2026-11-05',
  // -2 → 老面孔
  '2,o/old,https://github.com/o/old,https://hysenlabs.com/projects/o-old,500,5000,5500,10,-2,Python,MIT,2026-11-04,2026-11-05',
].join('\n');

globalThis.fetch = async (url) => {
  if (String(url).includes('/data/')) {
    return { ok: true, text: async () => csv, status: 200, statusText: 'OK' };
  }
  throw new Error('unexpected ' + url);
};

test('rank_change 为空 → 标记为新面孔；有数字 → 不是', async () => {
  let body;
  await I.handleRoute({}, { method: 'GET', url: '/dsh-github-hot/boards' }, {
    writeHead: () => {}, end: (d) => { body = JSON.parse(d); },
  });
  const day = body.boards.find((b) => b.label === '日榜');
  assert.ok(day, '应有日榜');
  const fresh = day.rows.find((r) => r.repository === 'o/brand-new');
  const old = day.rows.find((r) => r.repository === 'o/old');
  assert.equal(fresh.isNewToday, true);
  assert.equal(old.isNewToday, false);
  assert.equal(fresh.isNew, true, 'rank_change 为空应算新面孔');
  assert.equal(old.isNew, false, 'rank_change 有值不算新面孔');
  assert.equal(old.rankChange, -2, '名次变化照旧解析');
  assert.equal(fresh.rankChange, null, '空值解析成 null');
});

test('前端卡片会渲染 NEW 徽章，且随语言给不同 tooltip', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8');
  assert.match(src, /item\.isNew \? h\('span', \{ className: 'hp-new'/, '卡片按 isNew 渲染徽章');
  assert.match(src, /'card\.newTip': '近 3 个榜单日内新增上榜'/, '中文 tooltip');
  assert.match(src, /'card\.newTip': 'New within the last 3 ranking days'/, '英文 tooltip');
  assert.match(src, /\.hp-root\.hp-paper \.hp-new/, '纸感主题有独立样式');
});


test('新面孔只在日榜标记，周榜/月榜不标（避免整排 NEW 误导）', async () => {
  const { readFileSync } = await import('node:fs');
  const host = readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8');
  assert.match(host, /周榜不做新面孔标记/, '周榜显式不标');
  assert.match(host, /只有日榜标新面孔/, '月榜显式清掉标记');
  assert.match(host, /if \(path\.includes\('30d'\)\) \{[\s\S]{0,80}row\.isNew = false/, '30d 榜一次性置 false');
});
