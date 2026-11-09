import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';

const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8');
const row = (repository, rank = 1) => ({ repository, rank, starsGained: 20, endStars: 200 });
const series = (dates, stars) => ({ series: dates.map((date, i) => ({ date, stars: stars[i] })) });
const response = (body) => ({ ok: true, json: async () => ({ ok: true, ...body }) });
const text = (node) => node.children.map((c) => typeof c === 'string' ? c : text(c)).join('');
const click = async (root, label) => {
  const button = root.findAllByType('button').find((b) => text(b) === label);
  assert.ok(button, 'button exists: ' + label);
  await act(async () => { button.props.onClick(); });
};

async function mount({ lang = 'en', fetch, boards, now, retries, boardRetries, plainDeadlines } = {}) {
  let registration, Panel;
  const pending = [], intervals = new Set(), requests = [];
  const store = new Map([['dsh-github-hot:lang', lang]]);
  const sandbox = {
    console, AbortController, clearTimeout,
    setTimeout: (fn, ms) => {
      if (plainDeadlines && ms === 10000) { plainDeadlines.push(fn); return 0; }
      if (boardRetries && ms === 8000) { boardRetries.push(fn); return 0; }
      if (retries && ms === 2500) { retries.push(fn); return 0; }
      return setTimeout(fn, ms);
    },
    setInterval: (fn) => { intervals.add(fn); return fn; },
    clearInterval: (fn) => intervals.delete(fn),
    document: { getElementById: () => ({}), createElement: () => ({}), head: { appendChild() {} } },
    localStorage: { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v) },
    window: { __ModuleLoader__: { load: (r) => { registration = r; } } },
    fetch: async (url) => {
      const u = new URL(url, 'http://localhost');
      requests.push(u);
      const custom = fetch?.(u, pending);
      if (custom) return custom;
      if (u.pathname.endsWith('/boards')) return response({ boards: boards || [
        { id: 'day', label: 'Daily', ok: true, rows: [row('o/a'), row('o/b', 2)] },
        { id: 'week', label: 'Weekly', ok: true, rows: [row('o/c')] },
      ] });
      return response({ items: [] });
    },
  };
  if (now) sandbox.Date = class extends Date {
    constructor(...args) { super(...(args.length ? args : [now.value])); }
    static now() { return now.value; }
  };
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox);
  registration.factory((name) => { assert.equal(name, 'react'); return React; }).apply({ slots: {
    inject: (_slot, gen) => gen().next(),
    register: (spec, component) => { if (spec.name === 'main') Panel = component; return () => {}; },
  } });
  let renderer;
  await act(async () => { renderer = TestRenderer.create(React.createElement(Panel)); });
  return {
    renderer, requests, intervals, components: sandbox.__DSH_HYSEN_PULSE_TEST__,
    async close() {
      await act(async () => { renderer.unmount(); pending.forEach((resolve) => resolve(response({ items: [] }))); });
    },
  };
}

test('opening B after A ignores the late A response', async () => {
  const details = new Map();
  const app = await mount({ fetch: (url, pending) => {
    if (!url.pathname.endsWith('/detail')) return;
    return new Promise((resolve) => { details.set(url.searchParams.get('repo'), resolve); pending.push(resolve); });
  } });
  try {
    const cardNodes = app.renderer.root.findAll((n) => n.type === app.components.Card);
    assert.equal(cardNodes.length, 2);
    await act(async () => { cardNodes[0].props.onSelect(cardNodes[0].props.item); });
    await act(async () => { cardNodes[1].props.onSelect(cardNodes[1].props.item); });
    await act(async () => { details.get('o/b')(response({ detail: { repository: 'o/b', desc: 'B content' } })); });
    await act(async () => { details.get('o/a')(response({ detail: { repository: 'o/a', desc: 'A content' } })); });
    const detail = app.renderer.root.findByType(app.components.Detail);
    assert.equal(detail.props.item.repository, 'o/b');
    assert.equal(detail.props.detail.repository, 'o/b');
    assert.equal(detail.props.loading, false);
  } finally { await app.close(); }
});

test('first Chinese load requests translations for newly fetched descriptions', async () => {
  const app = await mount({ lang: 'zh', fetch: (url) => {
    if (url.pathname.endsWith('/batch')) return response({ items: [
      { repository: 'o/a', desc: 'English description', chart: null },
    ] });
    if (url.pathname.endsWith('/translate')) return response({ items: [
      { repository: 'o/a', descZh: '中文简介' },
    ] });
  } });
  try {
    assert.ok(app.requests.some((u) => u.pathname.endsWith('/translate')));
    const card = app.renderer.root.findAllByType(app.components.Card).find((n) => n.props.item.repository === 'o/a');
    assert.equal(card.props.detail.descZh, '中文简介');
  } finally { await app.close(); }
});

test('day → week → day while loading still admits the latest day batch', async () => {
  const app = await mount({ fetch: (url, pending) => {
    if (!url.pathname.endsWith('/batch')) return;
    return new Promise((resolve) => pending.push(resolve));
  } });
  try {
    await click(app.renderer.root, 'Weekly');
    await click(app.renderer.root, 'Daily');
    assert.equal(app.requests.filter((u) => u.pathname.endsWith('/batch') && u.searchParams.get('repos') === 'o/a,o/b').length, 2);
  } finally { await app.close(); }
});

test('a panel left open refreshes on every date rollover', async () => {
  const now = { value: Date.parse('2026-11-04T15:59:00Z') };
  const app = await mount({ now });
  try {
    for (const date of ['2026-11-04T16:01:00Z', '2026-11-05T16:01:00Z']) {
      now.value = Date.parse(date);
      await act(async () => { for (const tick of [...app.intervals]) tick(); });
    }
    assert.equal(app.requests.filter((u) => u.pathname.endsWith('/boards')).length, 3);
  } finally { await app.close(); }
});

test('statistics buttons select real renderable curves and clear them', async () => {
  const app = await mount();
  let dashboard;
  try {
    const rows = Array.from({ length: 12 }, (_, i) => row('o/r' + i, i + 1));
    const charts = Object.fromEntries(rows.map((r, i) => [r.repository,
      series(i === 0 ? [] : ['2026-11-01', '2026-11-02', '2026-11-03'], [100, 110, 120]),
    ]));
    await act(async () => { dashboard = TestRenderer.create(React.createElement(app.components.Dashboard, { React, rows, charts, lang: 'zh' })); });
    await click(dashboard.root, '前 5');
    assert.equal(dashboard.root.findAllByType('input').filter((n) => n.props.checked).length, 5);
    assert.equal(dashboard.root.findAllByType('input')[0].props.checked, false);
    await click(dashboard.root, '全选');
    assert.equal(dashboard.root.findAllByType('input').filter((n) => n.props.checked).length, 11);
    await click(dashboard.root, '清空');
    assert.equal(dashboard.root.findAllByType('input').filter((n) => n.props.checked).length, 0);
  } finally {
    if (dashboard) await act(async () => dashboard.unmount());
    await app.close();
  }
});

test('daily statistics clips history to the board window and accepts two samples', async () => {
  const app = await mount();
  let dashboard;
  try {
    await act(async () => { dashboard = TestRenderer.create(React.createElement(app.components.Dashboard, {
      React, lang: 'en', rows: [row('o/a')],
      window: { start: '2026-11-02', end: '2026-11-03' },
      charts: { 'o/a': series(['2026-10-01', '2026-11-02', '2026-11-03'], [10, 100, 120]) },
    })); });
    const axes = dashboard.root.findAllByProps({ className: 'hp-axis' }).map(text);
    assert.ok(axes.includes('11/2'));
    assert.ok(axes.includes('11/3'));
    assert.ok(!axes.includes('10/1'));
    assert.equal(dashboard.root.findAllByProps({ className: 'hp-series' }).length, 1);
    assert.ok(text(dashboard.root.findByProps({ className: 'hp-legend' })).includes('20'));
  } finally {
    if (dashboard) await act(async () => dashboard.unmount());
    await app.close();
  }
});

test('star losses remain visible instead of being clamped to zero', async () => {
  const app = await mount();
  let dashboard;
  try {
    await act(async () => { dashboard = TestRenderer.create(React.createElement(app.components.Dashboard, {
      React, lang: 'en', rows: [row('o/a')],
      charts: { 'o/a': series(['2026-11-01', '2026-11-02', '2026-11-03'], [100, 90, 80]) },
    })); });
    const path = dashboard.root.findByProps({ className: 'hp-series' }).props.d;
    const y = [...path.matchAll(/[ML]([\d.]+)[ ,]([\d.]+)/g)].map((m) => Number(m[2]));
    assert.ok(y[y.length - 1] > y[0], path);
    assert.ok(dashboard.root.findAllByProps({ className: 'hp-axis' }).some((n) => text(n).startsWith('-')));
  } finally {
    if (dashboard) await act(async () => dashboard.unmount());
    await app.close();
  }
});

test('daily statistics uses one avatar per project, positioned by exact daily gain', async () => {
  const app = await mount();
  let dashboard;
  try {
    await act(async () => { dashboard = TestRenderer.create(React.createElement(app.components.Dashboard, {
      React, lang: 'zh', periodKey: 'day', charts: {},
      rows: [{ ...row('o/a'), starsGained: 100 }, { ...row('o/b', 2), starsGained: 20 }],
      window: { start: '2026-11-02', end: '2026-11-03' },
    })); });
    assert.equal(dashboard.root.findAllByProps({ className: 'hp-series' }).length, 0);
    const avatars = dashboard.root.findAllByProps({ className: 'hp-daily-avatar' });
    assert.equal(avatars.length, 2);
    assert.ok(avatars[0].props.y < avatars[1].props.y);
    assert.ok(dashboard.root.findAllByType('input').every((n) => !n.props.disabled));
    await click(dashboard.root, '清空');
    assert.equal(dashboard.root.findAllByProps({ className: 'hp-daily-avatar' }).length, 0);
    await click(dashboard.root, '全选');
    assert.equal(dashboard.root.findAllByProps({ className: 'hp-daily-avatar' }).length, 2);
  } finally {
    if (dashboard) await act(async () => dashboard.unmount());
    await app.close();
  }
});

test('a late chart is fetched again and appears without reopening the panel', async () => {
  const retries = [];
  let batches = 0;
  const chart = series(['2026-11-01', '2026-11-02'], [100, 120]);
  const app = await mount({ retries, fetch: (url) => {
    if (!url.pathname.endsWith('/batch')) return;
    batches++;
    return response({ items: [{ repository: 'o/a', desc: 'Description',
      chart: batches === 1 ? null : chart, chartPending: batches === 1 }] });
  } });
  try {
    assert.equal(retries.length, 1);
    await act(async () => { retries.shift()(); });
    const card = app.renderer.root.findAllByType(app.components.Card).find((n) => n.props.item.repository === 'o/a');
    assert.equal(card.props.detail.chart.series.length, 2);
    assert.equal(retries.length, 0);
  } finally { await app.close(); }
});

test('removing the outlier switches monthly trends to a readable linear axis', async () => {
  const app = await mount();
  let dashboard;
  try {
    const rows = [row('o/leader'), row('o/a', 2), row('o/b', 3)];
    const charts = Object.fromEntries(rows.map((r, i) => [r.repository,
      series(['2026-11-01', '2026-11-02', '2026-11-03'], [100, 101, 100 + [425000, 30000, 22000][i]]),
    ]));
    await act(async () => { dashboard = TestRenderer.create(React.createElement(app.components.Dashboard, { React, rows, charts, lang: 'zh', periodKey: 'month' })); });
    assert.ok(text(dashboard.root.findAllByProps({ className: 'hp-mchart-hint' }).at(-1)).includes('对数'));
    await act(async () => dashboard.root.findAllByType('input')[0].props.onChange());
    assert.ok(text(dashboard.root.findAllByProps({ className: 'hp-mchart-hint' }).at(-1)).includes('线性'));
    const dots = dashboard.root.findAllByProps({ className: 'hp-endpoint-dot' });
    assert.ok(Math.abs(dots[0].props.cy - dots[1].props.cy) > 50);
  } finally {
    if (dashboard) await act(async () => dashboard.unmount());
    await app.close();
  }
});

test('twenty nearly equal endpoints keep separate avatars and true value dots', async () => {
  const app = await mount();
  let dashboard;
  try {
    const rows = Array.from({ length: 20 }, (_, i) => row('o/r' + i, i + 1));
    const charts = Object.fromEntries(rows.map((r, i) => [r.repository,
      series(['2026-11-01', '2026-11-02', '2026-11-03'], [100, 101, 30100 - i]),
    ]));
    await act(async () => { dashboard = TestRenderer.create(React.createElement(app.components.Dashboard, { React, rows, charts, lang: 'zh', periodKey: 'month' })); });
    await click(dashboard.root, '全选');
    const avatars = dashboard.root.findAllByProps({ className: 'hp-endpoint-avatar' });
    assert.equal(avatars.length, 20);
    const ys = avatars.map((n) => n.props.y).sort((a, b) => a - b);
    for (let i = 1; i < ys.length; i++) assert.ok(ys[i] - ys[i - 1] >= 22);
    const dots = dashboard.root.findAllByProps({ className: 'hp-endpoint-dot' });
    assert.equal(dots.length, 20);
    assert.ok(Math.abs(dots[0].props.cy - dots[19].props.cy) < 2);
    assert.equal(dashboard.root.findAllByProps({ className: 'hp-endpoint-link' }).length, 20);
  } finally {
    if (dashboard) await act(async () => dashboard.unmount());
    await app.close();
  }
});

test('background refresh remains visible until a completed response arrives', async () => {
  const polls = [];
  let calls = 0;
  const app = await mount({ boardRetries: polls, fetch: (url) => {
    if (!url.pathname.endsWith('/boards')) return;
    calls++;
    return response({ fetchedAt: '2026-11-08T00:00:00Z', refreshing: calls === 1,
      boards: [{ id: 'day', label: 'Daily', ok: true, rows: [row('o/a')] }] });
  } });
  try {
    assert.ok(text(app.renderer.root).includes('Fetching the latest data'));
    const refresh = app.renderer.root.findAllByType('button').find((b) => text(b) === 'Refreshing…');
    assert.equal(refresh.props.disabled, true);
    assert.equal(polls.length, 1);
    await act(async () => { polls.shift()(); });
    assert.equal(app.renderer.root.findAll((n) => n.props.className === 'hp-banner hp-fetch-status').length, 0, 'completed refresh has no permanent banner');
    assert.equal(app.renderer.root.findAllByType('button').find((b) => text(b) === 'Refresh').props.disabled, false);
  } finally { await app.close(); }
});

test('collection replaces summary cards and supports paging, search and project details', async () => {
  const collection = Array.from({ length: 25 }, (_, i) => ({ ...row('archive/project-' + String(i).padStart(2, '0')),
    firstDay: '2026-11-01', lastDay: '2026-11-05', isNew: true, language: 'TypeScript', license: 'MIT' }));
  const app = await mount({ fetch: (url) => {
    if (url.pathname.endsWith('/boards')) return response({
      boards: [{ id: 'day', label: 'Daily', ok: true, rows: [row('o/a')] }], collection,
    });
    if (url.pathname.endsWith('/detail')) return response({ detail: { desc: 'Archived project description' } });
  } });
  try {
    assert.equal(app.renderer.root.findAll((n) => n.props.className === 'hp-stat-card rose').length, 0);
    await click(app.renderer.root, 'Browse collection →');
    const entries = () => app.renderer.root.findAllByType('article').filter((n) => n.props.className.includes('hp-collection-row'));
    assert.equal(entries().length, 20);
    assert.equal(entries()[0].findAllByType('img').length, 1, 'same avatar component as ranking cards');
    assert.ok(text(entries()[0]).includes('TypeScript'));
    assert.ok(text(entries()[0]).includes('MIT'));
    assert.ok(text(entries()[0]).includes('Daily gain when ranked'));
    assert.equal(entries()[0].findAll((n) => n.props.className === 'hp-new').length, 0, 'archived entries do not display NEW');
    await click(app.renderer.root, 'Next');
    assert.equal(entries().length, 5);
    const input = app.renderer.root.findByType('input');
    await act(async () => input.props.onChange({ target: { value: 'project-03' } }));
    assert.equal(entries().length, 1);
    assert.ok(text(entries()[0]).includes('First collected 2026-11-01'));
    await act(async () => entries()[0].props.onClick());
    assert.equal(app.renderer.root.findByType(app.components.Detail).props.item.repository, 'archive/project-03');
  } finally { await app.close(); }
});


test('new project alert counts only latest-day arrivals, independently of three-day NEW badges', async () => {
  const app = await mount({ boards: [{ id: 'day', label: 'Daily', ok: true, window: { end: '2026-11-08' }, rows: [
    { ...row('o/today'), isNew: true, isNewToday: true },
    { ...row('o/yesterday', 2), isNew: true, isNewToday: false },
  ] }] });
  try {
    const alert = app.renderer.root.find((n) => n.props.className === 'hp-hero-main');
    assert.ok(text(alert).includes('1 new projects appeared today!'));
    assert.ok(text(alert).includes('o/today'));
    assert.equal(text(alert).includes('o/yesterday'), false);
    assert.equal(app.renderer.root.findAll((n) => n.props.className === 'hp-banner hp-fetch-status').length, 0);
    const newcomer = alert.findByType('button');
    await act(async () => newcomer.props.onClick());
    assert.equal(app.renderer.root.findByType(app.components.Detail).props.item.repository, 'o/today');
  } finally { await app.close(); }
});


test('plain explanation loads independently of original detail and credits the model', async () => {
  const app = await mount({ fetch: (url, pending) => {
    if (url.pathname.endsWith('/detail')) return new Promise((resolve) => pending.push(resolve));
    if (url.pathname.endsWith('/explain')) return response({ status: 'ready', explanation: {
      what: 'Find public profiles by username.',
    } });
  } });
  try {
    const card = app.renderer.root.findAllByType(app.components.Card)[0];
    await act(async () => card.props.onSelect(card.props.item));
    assert.equal(app.renderer.root.findByType(app.components.Detail).props.loading, true, 'original detail can still be loading');
    const plain = app.renderer.root.find((n) => n.props.className === 'hp-plain');
    assert.ok(text(plain).includes('Find public profiles'));
    assert.ok(text(plain).includes('Generated by the DSH model'));
    assert.equal(plain.findAllByType('dt').length, 0, 'plain explanation is a single direct paragraph');
    assert.equal(text(plain).includes('When would I use it?'), false);
  } finally { await app.close(); }
});

test('plain explanation stops waiting at its deadline and ignores late responses', async () => {
  const deadlines = [];
  let resolveExplanation;
  const app = await mount({ plainDeadlines: deadlines, fetch: (url, pending) => {
    if (url.pathname.endsWith('/explain')) return new Promise((resolve) => { resolveExplanation = resolve; pending.push(resolve); });
  } });
  try {
    const card = app.renderer.root.findAllByType(app.components.Card)[0];
    await act(async () => card.props.onSelect(card.props.item));
    assert.equal(deadlines.length, 1);
    await act(async () => deadlines[0]());
    const plain = () => app.renderer.root.find((n) => n.props.className === 'hp-plain');
    assert.ok(text(plain()).includes('Generation is taking longer'));
    await act(async () => resolveExplanation(response({ status: 'ready', explanation: { what: 'Late explanation', when: 'Late use case' } })));
    assert.equal(text(plain()).includes('Late explanation'), false);
    assert.ok(plain().findAllByType('button').some((b) => text(b) === 'Try again'));
  } finally { await app.close(); }
});


test('period buttons leave the collection and show the matching ranking, including reselecting Daily', async () => {
  const app = await mount({ boards: [
    { id: 'day', label: 'Daily', ok: true, rows: [row('nav/day')] },
    { id: 'week', label: 'Weekly', ok: true, rows: [row('nav/week')] },
    { id: 'month', label: 'Monthly', ok: true, rows: [row('nav/month')] },
  ] });
  try {
    for (const [label, repo] of [['Daily','nav/day'], ['Weekly','nav/week'], ['Monthly','nav/month']]) {
      await click(app.renderer.root, 'Daily discoveries');
      assert.ok(app.renderer.root.findAllByType('input').length);
      await click(app.renderer.root, label);
      assert.equal(app.renderer.root.findAllByType('input').length, 0);
      const cards = app.renderer.root.findAllByType(app.components.Card);
      assert.equal(cards.length, 1);
      assert.equal(cards[0].props.item.repository, repo);
    }
  } finally { await app.close(); }
});

test('new project notice follows period and date without treating missing weekly/monthly evidence as zero', async () => {
  const app = await mount({ lang: 'zh', boards: [
    { id: 'day', label: '日榜', ok: true, window: { end:'2026-11-08' }, rows: [{ ...row('notice/day'), isNewToday:true }] },
    { id: 'week', label: '周榜', ok: true, week:'2026-11-02', window: {end:'November 8, 2026'}, rows:[row('notice/week')] },
    { id: 'month', label: '月榜', ok: true, window:{end:'2026-11-09'}, rows:[row('notice/month')] },
  ] });
  const notice = () => text(app.renderer.root.find((n) => n.props.className === 'hp-hero-main'));
  try {
    assert.ok(notice().includes('今天有 1 个新项目'));
    await click(app.renderer.root, '周榜');
    assert.ok(notice().includes('暂无法确认本周新增项目'));
    assert.ok(notice().includes('按 26.11.8 周榜 TOP10 统计'));
    assert.equal(notice().includes('notice/day'), false);
    await click(app.renderer.root, '月榜');
    assert.ok(notice().includes('暂无法确认本月新增项目'));
    assert.ok(notice().includes('按 26.11.9 月榜 TOP20 统计'));
    assert.equal(notice().includes('今天'), false);
    await click(app.renderer.root, '日榜');
    assert.ok(notice().includes('今天有 1 个新项目'));
  } finally { await app.close(); }
});
