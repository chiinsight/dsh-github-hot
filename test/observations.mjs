import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const home = mkdtempSync(join(tmpdir(), 'hot-observations-'));
process.env.DSH_HOME = home;
const { __internals: I } = await import('../lib/index.js');
test.after(() => rmSync(home, { recursive: true, force: true }));
const row = (repository, isNew = false) => ({ repository, isNew, starsGained: 42 });
const board = (date, rows) => ({ ok: true, window: { end: date }, rows });

test('NEW lasts exactly three ranking days, survives numeric rank changes and does not restart', () => {
  I.observeBoard('day', board('2026-11-06', [row('o/new', true), row('o/existing')]));
  I.observeBoard('day', board('2026-11-07', [row('O/NEW')]));
  assert.equal(I.recentNew('o/new', '2026-11-06'), true);
  assert.equal(I.recentNew('O/NEW', '2026-11-07'), true);
  assert.equal(I.recentNew('o/new', '2026-11-08'), true);
  assert.equal(I.recentNew('o/new', '2026-11-09'), false);
  assert.equal(I.recentNew('o/new', '2026-11-05'), false);
  assert.equal(I.recentNew('o/existing', '2026-11-06'), false);
  I.observeBoard('day', board('2026-11-10', [row('o/new', true)]));
  assert.equal(I.recentNew('o/new', '2026-11-10'), false);
});

test('collection retains departed daily projects, excludes every observed weekly project and deduplicates names', () => {
  I.observeBoard('week', board('2026-11-01', [row('o/weekly-first')]));
  I.observeBoard('day', board('2026-11-08', [row('o/weekly-first'), row('o/brief'), row('o/graduates')]));
  I.observeBoard('week', board('2026-11-08', [row('O/GRADUATES')]));
  I.observeBoard('day', board('2026-11-09', [row('O/BRIEF')]));
  I.observeBoard('day', board('2026-11-10', [row('o/later')]));
  const rows = I.collectionRows();
  assert.equal(rows.filter((r) => r.repository.toLowerCase() === 'o/brief').length, 1);
  const brief = rows.find((r) => r.repository.toLowerCase() === 'o/brief');
  assert.equal(brief.firstDay, '2026-11-08');
  assert.equal(brief.lastDay, '2026-11-09');
  assert.equal(rows.some((r) => /weekly-first|graduates/i.test(r.repository)), false);
  assert.equal(rows[0].lastDay, '2026-11-10');
  assert.equal(brief.isNew, false);
});

test('only daily TOP20 enter collection and failed snapshots cannot change observations', () => {
  const rows = Array.from({ length: 21 }, (_, i) => row('limit/r' + i));
  I.observeBoard('day', board('2026-11-10', rows));
  assert.equal(I.collectionRows().filter((r) => r.repository.startsWith('limit/')).length, 20);
  I.observeBoard('week', { ...board('2026-11-11', [row('o/brief')]), ok: false });
  assert.equal(I.collectionRows().some((r) => r.repository.toLowerCase() === 'o/brief'), true);
});

test('history and NEW survive restart even when ordinary cache is gone', () => {
  const moduleUrl = new URL('../lib/index.js', import.meta.url).href;
  const output = execFileSync(process.execPath, ['--input-type=module', '-e', `
    const { __internals: I } = await import(${JSON.stringify(moduleUrl)});
    console.log(JSON.stringify({ rows: I.collectionRows(), recent: I.recentNew('o/new', '2026-11-08') }));
  `], { env: { ...process.env, DSH_HOME: home }, encoding: 'utf8' });
  const restored = JSON.parse(output);
  assert.deepEqual(restored.rows, I.collectionRows());
  assert.equal(restored.recent, true);
});
