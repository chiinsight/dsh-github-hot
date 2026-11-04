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

async function mount({ lang = 'en', fetch, boards, now, retries } = {}) {
  let registration, Panel;
  const pending = [], intervals = new Set(), requests = [];
  const store = new Map([['dsh-github-hot:lang', lang]]);
  const sandbox = {
    console, AbortController, clearTimeout,
    setTimeout: (fn, ms) => {
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
