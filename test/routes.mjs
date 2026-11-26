import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const home = mkdtempSync(join(tmpdir(), 'dsh-routes-'));
process.env.DSH_HOME = home;
const { __internals: I } = await import('../lib/index.js');
const originalFetch = globalThis.fetch;
test.after(() => { globalThis.fetch = originalFetch; rmSync(home, { recursive: true, force: true }); });
async function route(url, ctx = {}) {
  let status, body;
  await I.handleRoute(ctx, { method: 'GET', url }, {
    writeHead: (code) => { status = code; }, end: (data) => { body = JSON.parse(data); },
  });
  assert.equal(status, 200, JSON.stringify(body));
  return body;
}

test('explicit English batch never starts background model work', async () => {
  I.cacheSet('detail:o-en', { repository: 'o/en', glance: [], desc: 'Unique uncached description', chart: null });
  let modelReads = 0;
  globalThis.fetch = async () => { throw new Error('No network expected'); };
  const ctx = { llm: { stream() {}, listProviders() { modelReads++; return []; }, listModels: () => [] } };
  const body = await route('/dsh-github-hot/batch?repos=o/en&translate=0', ctx);
  assert.equal(body.items[0].desc, 'Unique uncached description');
  await new Promise(setImmediate);
  assert.equal(modelReads, 0);
});

test('English detail also avoids model work', async () => {
  I.cacheSet('detail:o-detail-en', { repository: 'o/detail-en', glance: [], desc: 'An untranslated detail', chart: null });
  let modelReads = 0;
  const ctx = { llm: { stream() {}, listProviders() { modelReads++; return []; }, listModels: () => [] } };
  await route('/dsh-github-hot/detail?repo=o/detail-en&translate=0', ctx);
  assert.equal(modelReads, 0);
});

test('translation respects the current Harness default model API', async () => {
  const ctx = {
    agentDefaultModel: { currentSelection: () => ({ provider: 'preferred', model: 'chosen' }) },
    llm: { async *stream() {}, listProviders: () => [] },
  };
  const body = await route('/dsh-github-hot/diag', ctx);
  assert.deepEqual(body.diag.picked, { provider: 'preferred', model: 'chosen' });
});

test('a slow chart replaces the pending cached result when it arrives', async () => {
  let resolveChart;
  globalThis.fetch = async (url) => ({ ok: true, text: async () => String(url).includes('/chart/')
    ? new Promise((resolve) => { resolveChart = resolve; }) : '<html>Project page</html>' });
  const first = await route('/dsh-github-hot/detail?repo=o/slow');
  assert.equal(first.detail.chartPending, true);
  resolveChart('<svg><path d="M60 300 L418 200 L776 100"/>' +
    '<line y1="326"/><text y="330">0</text><line y1="100"/><text y="104">100</text>' +
    '<text x="60" y="348">Nov 1</text><text x="776" y="348">Nov 3</text></svg>');
  await new Promise(setImmediate);
  const second = await route('/dsh-github-hot/detail?repo=o/slow');
  assert.equal(second.detail.chartPending, false);
  assert.equal(second.detail.chart.series.length, 3);
});

test('a project profile with only technical Q&A recovers its purpose from the page description', async () => {
  const repository = 'example/profile-only';
  const technical = { q: 'What is it written in?', a: 'Mainly Python.' };
  I.cacheSet('detail:example-profile-only', {
    repository, desc: technical.a, descSource: 'overview', whatIsIt: technical.a, glance: [technical], chart: null,
  });
  const purpose = 'A tool for organizing photos by date.';
  globalThis.fetch = async (url) => ({
    ok: true,
    text: async () => String(url).includes('/projects/')
      ? `<html><head><meta name="description" content="${purpose}"/></head><dl><dt>${technical.q}</dt><dd>${technical.a}</dd></dl></html>`
      : '<svg/>',
  });
  const ctx = { get() { throw new Error('Cache-only detail must not resolve a model'); } };
  const { detail } = await route('/dsh-github-hot/detail?repo=' + repository + '&translate=cached', ctx);
  assert.equal(detail.desc, purpose);
  assert.deepEqual(detail.glance[0], { q: 'What is it?', a: purpose });
  assert.deepEqual(detail.glance[1], technical);
  assert.equal(JSON.parse(I.explanationSource(detail)).purpose, purpose);
  assert.equal(I.parseWhatIsIt('<dl><dt>What is it written in?</dt><dd>Mainly Python.</dd></dl>'), null);
});

test('detail strips repeated question labels from cached and newly generated translations', async () => {
  const glance = [
    { q: 'What is it?', a: 'Organizes pictures into albums.' },
    { q: 'Who is it for?', a: 'People with a large photo collection.' },
    { q: 'What is it written in?', a: 'Mainly TypeScript.' },
  ];
  I.cacheSet('detail:o-qa-prefix', { repository: 'o/qa-prefix', glance, chart: null });
  I.zhCacheSet('glance-zh:v2:' + glance[0].q + ':' + glance[0].a, '这是什么？ —— 把照片整理成相册。');
  const url = '/dsh-github-hot/detail?repo=o/qa-prefix&translate=';
  const cached = await route(url + 'cached');
  assert.deepEqual(cached.detail.glanceZh, ['把照片整理成相册。', null, null]);

  const ctx = {
    agentDefaultModel: { currentSelection: () => ({ provider: 'stub', model: 'stub' }) },
    llm: { async *stream({ messages }) {
      assert.equal(JSON.parse(messages[0].content[0].text)[0].number, 2);
      yield { type: 'text-delta', text: '2）它面向谁？ —— 适合照片很多的人。\n3．它用什么编写？ —— 主要用 TypeScript。' };
    } },
  };
  const translated = await route(url + 'glance', ctx);
  assert.deepEqual(translated.detail.glanceZh, ['把照片整理成相册。', '适合照片很多的人。', '主要用 TypeScript。']);
});

test('weekly pages with duplicate markup return one row per rank and repository', () => {
  const item = (rank, repo) => `<li data-testid="ranking-row-${rank}"><a class="weekly__repo" href="/projects/o-${repo}"><span>o</span> / ${repo}</a><strong class="weekly__weekly" data-testid="weekly-stars-${rank}">12</strong></li>`;
  const rows = I.parseWeeklyHtml(item(1, 'a') + item(1, 'a') + item(2, 'b'));
  assert.deepEqual(Array.from(rows, (entry) => [entry.rank, entry.repository]), [[1, 'o/a'], [2, 'o/b']]);
});
