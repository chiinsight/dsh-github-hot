import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
const home = mkdtempSync(join(tmpdir(), 'hot-explain-'));
process.env.DSH_HOME = home;
process.env.HOME = home;
const moduleUrl = new URL('../lib/index.js', import.meta.url).href;
const { __internals: I } = await import(moduleUrl);
const originalFetch = globalThis.fetch;
globalThis.fetch = async () => { throw new Error('Unexpected network'); };
test.after(() => { globalThis.fetch = originalFetch; rmSync(home, { recursive: true, force: true }); });
const output = { what: '输入用户名，检查几百个社交网站上有没有同名账号。' };
const seed = (repo, desc = 'Find public usernames across websites.') => I.cacheSet('detail:' + I.slugOf(repo), { repository: repo, desc, glance: [], chart: null });
function context(onCall = () => {}, raw = JSON.stringify(output)) {
  return { agentDefaultModel: { currentSelection: () => ({ provider: 'host', model: 'default' }) },
    llm: { async *stream(options) { onCall(options); yield { type: 'text-delta', text: raw }; } } };
}
async function idle() {
  const deadline = Date.now() + 2000;
  while (I.__explanationTasks.size && Date.now() < deadline) await new Promise((r) => setTimeout(r, 2));
  assert.equal(I.__explanationTasks.size, 0, 'queue finishes');
}

test('host default model generates once, deduplicates requests and invalidates changed source', async () => {
  seed('o/source'); let calls = 0;
  const ctx = context((options) => { calls++; assert.equal(options.provider, 'host'); assert.equal(options.model, 'default'); assert.ok(options.signal); assert.equal(JSON.parse(options.messages[0].content[0].text).repository, 'o/source'); assert.ok(options.system.includes('只解释用途')); });
  assert.equal(I.requestExplanation(ctx, 'o/source', 'zh').status, 'pending');
  assert.equal(I.requestExplanation(ctx, 'o/source', 'zh').status, 'pending');
  await idle();
  assert.equal(calls, 1);
  assert.deepEqual(I.requestExplanation(ctx, 'o/source', 'zh').explanation, output);
  seed('o/source', 'Changed source about a different capability.');
  assert.equal(I.requestExplanation(ctx, 'o/source', 'zh').status, 'pending');
  await idle(); assert.equal(calls, 2);
});

test('foreground work precedes queued background work, then total stars determine order', async () => {
  const rows = [{ repository: 'sort/low', endStars: 50, starsGained: 10000 },
    { repository: 'sort/high', endStars: 50000, starsGained: 1 }, { repository: 'sort/mid', endStars: 5000 }];
  rows.forEach((r) => seed(r.repository)); seed('sort/clicked');
  I.cacheSet('board:day', { ok: true, rows });
  const order = [];
  const ctx = context((options) => order.push(options.sessionId.split(':').pop()));
  assert.deepEqual(I.prewarmExplanations(ctx, 'zh'), ['sort/high', 'sort/mid', 'sort/low']);
  I.requestExplanation(ctx, 'sort/clicked', 'zh');
  await idle();
  assert.deepEqual(order, ['sort/clicked', 'sort/high', 'sort/mid', 'sort/low']);
});

test('cached explanation survives restart without a model or network request', () => {
  I.flushZhNow();
  const result = execFileSync(process.execPath, ['--input-type=module', '-e', `
    const { __internals: I } = await import(${JSON.stringify(moduleUrl)});
    I.cacheSet('detail:o-source', {repository:'o/source', desc:'Changed source about a different capability.',glance:[],chart:null});
    console.log(JSON.stringify(I.requestExplanation({}, 'o/source', 'zh')));
  `], { encoding: 'utf8', env: { ...process.env, HOME: home, DSH_HOME: home } });
  assert.deepEqual(JSON.parse(result), { status: 'ready', explanation: output });
});

test('bad model output and missing evidence report errors rather than fabricated explanations', async () => {
  seed('bad/json');
  I.requestExplanation(context(() => {}, 'not json'), 'bad/json', 'zh');
  seed('bad/verbose');
  I.requestExplanation(context(() => {}, JSON.stringify({ what: '冗长技术摘要'.repeat(25) })), 'bad/verbose', 'zh');
  seed('bad/evidence', '');
  I.requestExplanation(context(), 'bad/evidence', 'zh');
  await idle();
  assert.equal(I.requestExplanation({}, 'bad/json', 'zh').status, 'error');
  assert.equal(I.requestExplanation({}, 'bad/verbose', 'zh').status, 'error', 'long technical essays cannot be cached');
  assert.equal(I.requestExplanation({}, 'bad/evidence', 'zh').reason, 'source');
});

test('backend enforces its deadline and signals cancellation to the host model', async () => {
  seed('slow/model');
  const originalTimeout = globalThis.setTimeout;
  let aborted = false;
  globalThis.setTimeout = (fn, ms, ...args) => originalTimeout(fn, ms === 12000 ? 10 : ms, ...args);
  const ctx = { ...context(), llm: { async *stream({ signal }) {
    await new Promise((_, reject) => signal.addEventListener('abort', () => { aborted = true; reject(new Error('timeout')); }, { once: true }));
  } } };
  try {
    I.requestExplanation(ctx, 'slow/model', 'zh');
    await idle();
    assert.equal(aborted, true);
    assert.equal(I.requestExplanation(ctx, 'slow/model', 'zh').reason, 'timeout');
  } finally { globalThis.setTimeout = originalTimeout; }
});


test('old two-section explanation cache is not reused after prompt revision', async () => {
  const repo = 'old/prompt';
  const detail = { repository: repo, desc: 'Find usernames across websites.', glance: [], chart: null };
  seed(repo, detail.desc);
  I.zhCacheSet('plain-explanation:v1:' + repo + ':zh:' + I.explanationSource(detail), JSON.stringify({what:'旧的长篇技术摘要',when:'旧的使用场景'}));
  let calls = 0;
  const ctx = context(() => calls++);
  assert.equal(I.requestExplanation(ctx, repo, 'zh').status, 'pending');
  await idle();
  assert.equal(calls, 1);
  assert.deepEqual(I.requestExplanation(ctx, repo, 'zh').explanation, output);
});
