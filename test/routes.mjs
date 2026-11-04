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
