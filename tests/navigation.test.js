'use strict';

const assert = require('node:assert/strict');
const { AttentionClock, navigationEntries } = require('../src/navigation');
const { App, width } = require('../src/main');
const { Store } = require('../src/store');
const { buildWorld, record, addGhosts } = require('../src/world');

let checks = 0;
function test(name, fn) {
  fn();
  checks++;
  console.log(`  ok ${name}`);
}
function store() {
  // No real user state is read or written by these tests.
  const result = Object.create(Store.prototype);
  result.data = { version: 1, features: {} };
  result.dirty = false;
  return result;
}
const workspaces = [
  { workspace_id: 'w1', label: 'Orchard', number: 1 },
  { workspace_id: 'w2', label: 'Harbor', number: 2 },
];
function agent(pane, workspace, title, state = 'blocked', name = 'claude') {
  return { pane_id: pane, workspace_id: workspace, terminal_title: title, agent_status: state, agent: name };
}
const agents = [agent('p1', 'w1', 'Login fix'), agent('p2', 'w2', 'Search API', 'working', 'codex')];
function world(list = agents, s = store()) { return buildWorld({ workspaces, agents: list, at: 1000 }, s); }
function appFor(w = world(), s = store()) {
  const app = new App({ store: s, messages: { get: () => ({ lines: ['Hello'], at: 1 }), entries: new Map() } });
  app.world = w;
  app.attentionClock.update(w, 1000);
  return app;
}
function plain(frame) { return frame.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, ''); }

test('attention tracks observed waits, resets resumed panes, and prunes removed panes', () => {
  const clock = new AttentionClock();
  clock.update(world(), 1000);
  assert.equal(clock.since.get('p1'), 1000);
  const blocked = world([agents[0], { ...agents[1], agent_status: 'blocked' }]);
  clock.update(blocked, 2000);
  assert.deepEqual(navigationEntries(blocked, { kind: 'attention', clock }).map((e) => e.worker.paneId), ['p1', 'p2']);
  clock.update(world(), 3000);
  assert.equal(clock.since.has('p2'), false);
  clock.update(blocked, 4000);
  assert.equal(clock.since.get('p2'), 4000);
  clock.update(world([]), 5000);
  assert.equal(clock.since.size, 0);
});

test('search matches towns, task titles, agent names and pane IDs, case-insensitively', () => {
  const w = world();
  assert.equal(navigationEntries(w, { kind: 'search', query: 'HARBOR codex' })[0].worker.paneId, 'p2');
  assert.equal(navigationEntries(w, { kind: 'search', query: 'p1' }).length, 1);
  assert.equal(navigationEntries(w, { kind: 'search', query: 'login' }).length, 2);
  assert.equal(navigationEntries(w, { kind: 'search', query: 'orchard' })[0].kind, 'town');
  assert.deepEqual(navigationEntries(w, { kind: 'search', query: 'nonexistent' }), []);
});

test('building browser includes completed buildings and ruins with no live workers', () => {
  const s = store();
  s.data.features = {
    'w1::shipped': { label: 'Shipped', workspaceId: 'w1', ms: 120000, done: true, seen: 1000 },
    'w1::abandoned': { label: 'Abandoned', workspaceId: 'w1', ms: 120000, seen: 1000 },
  };
  const app = appFor(addGhosts(world([], s), s), s);
  app.onKey('b');
  assert.equal(app.browserEntries().length, 2);
  app.onKey('\r');
  assert.equal(app.mode, 'inspect');
  const frame = plain(app.render(80, 30));
  assert.match(frame, /complete \(historical\)/);
  assert.match(frame, /First recorded observation: not recorded/);
  app.onKey('\x1b');
  app.onKey('\x1b[B');
  app.onKey('\r');
  assert.match(plain(app.render(80, 30)), /ruin \(historical\)/);
});

test('recorder adds contributor metadata without changing old progress or inventing old dates', () => {
  const s = store();
  s.data.features['w1::login fix'] = { ms: 123456, seen: 1, done: true };
  const before = Date.now();
  record(world(agents, s), s);
  record(world(agents, s), s);
  const f = s.entry('w1::login fix');
  assert.equal(f.ms, 123456);
  assert.equal(f.done, true);
  assert.ok(f.firstObserved >= before);
  assert.equal(f.contributors.length, 1);
  record(world([agent('p3', 'w1', 'Login fix')], s), s);
  assert.equal(f.contributors.length, 2);
});

test('attention opens the right cross-town worker and escape returns to the same queue', () => {
  const app = appFor(world([agents[0], { ...agents[1], agent_status: 'blocked' }]));
  app.onKey('a');
  app.onKey('\x1b[B');
  app.onKey('\r');
  assert.equal(app.mode, 'read');
  assert.equal(app.readPaneId, 'p2');
  assert.equal(app.selectedTownId, 'w2');
  assert.match(plain(app.render(80, 24)), /codex/);
  app.onKey('r');
  app.onKey('hello q');
  assert.equal(app.replyText, 'hello q');
  assert.equal(app.running, true);
  app.onKey('\x1b');
  app.onKey('\x1b');
  assert.equal(app.mode, 'browse');
  assert.equal(app.browser.selectedId, 'worker:p2');
});

test('selection is pinned across reorder and never silently retargets a removed result', () => {
  const app = appFor();
  app.onKey('/');
  app.onKey('p1');
  app.world = world([agents[1], agents[0]]);
  assert.equal(app.browser.selectedId, 'worker:p1');
  app.world = world([agents[1]]);
  app.onKey('\r');
  assert.equal(app.mode, 'browse');
  app.onKey('\x15');
  app.onKey('p2');
  app.onKey('\r');
  assert.equal(app.readPaneId, 'p2');
  app.world = world([agents[0]]);
  assert.match(plain(app.render(80, 24)), /AGENT NO LONGER RUNNING/);
  app.onKey('r');
  assert.equal(app.replyMode, false);
  app.onKey('\r');
  assert.equal(app.pendingFocus, null);
});

test('typing search shortcuts is text, Unicode backspace works, and escape restores world view', () => {
  const app = appFor();
  app.mode = 'world';
  app.onKey('/');
  app.onKey('qjkl世界');
  app.onKey('\x7f');
  assert.equal(app.browser.query, 'qjkl世');
  assert.equal(app.running, true);
  app.onKey('\x15');
  assert.equal(app.browser.query, '');
  app.onKey('\x1b');
  assert.equal(app.mode, 'world');
});

test('search can visit a town, and wheel navigation works without stale sprite hits', () => {
  const app = appFor();
  app.onKey('/');
  app.onKey('Harbor');
  app.onKey('\r');
  assert.equal(app.mode, 'town');
  assert.equal(app.town.id, 'w2');
  app.onKey('/');
  const first = app.browser.selectedId;
  app.onMouse({ name: 'wheel-down', press: true });
  assert.notEqual(app.browser.selectedId, first);
});

test('new panels fit 40x16, 80x24 and 120x40, including wide and hostile titles', () => {
  const s = store();
  const w = world([agent('p1', 'w1', '世界'.repeat(70) + '\x1b[2J')], s);
  const app = appFor(w, s);
  for (const key of ['a', '/', 'b']) {
    app.mode = 'town';
    app.onKey(key);
    for (const [cols, rows] of [[40, 16], [80, 24], [120, 40]]) {
      const lines = plain(app.render(cols, rows)).split('\r\n');
      assert.equal(lines.length, rows);
      assert.ok(lines.every((line) => width(line) <= cols));
    }
  }
  app.onKey('\r');
  assert.equal(app.mode, 'inspect');
  for (const [cols, rows] of [[40, 16], [80, 24], [120, 40]]) {
    const lines = plain(app.render(cols, rows)).split('\r\n');
    assert.equal(lines.length, rows);
    assert.ok(lines.every((line) => width(line) <= cols));
  }
  app.onMouse({ name: 'wheel-down', press: true });
  assert.ok(app.inspectScroll > 0);
});

test('empty queue, missing building and stale snapshot errors are visible', () => {
  const app = appFor(world([]));
  app.onKey('a');
  assert.match(plain(app.render(80, 24)), /No blocked agents/);
  app.error = 'offline';
  assert.match(plain(app.render(80, 24)), /showing last snapshot/);
  app.mode = 'inspect';
  app.inspectKey = 'missing';
  assert.match(plain(app.render(80, 24)), /no longer available/);
});

test('queue does not retarget when the selected agent resumes but other agents remain', () => {
  const bothBlocked = [agents[0], { ...agents[1], agent_status: 'blocked' }];
  const app = appFor(world(bothBlocked));
  app.onKey('a');
  const pinned = app.browser.selectedId;
  app.world.towns.reverse();
  assert.equal(app.browser.selectedId, pinned);
  app.world = world([{ ...agents[0], agent_status: 'working' }, bothBlocked[1]]);
  app.attentionClock.update(app.world, 2000);
  app.onKey('\r');
  assert.equal(app.mode, 'browse');
  assert.match(plain(app.render(80, 24)), /Selection left this list/);
  app.onKey('\x1b[B');
  app.onKey('\r');
  assert.equal(app.readPaneId, 'p2');
});

test('long lists scroll to the selected result and historical buildings remain searchable', () => {
  const many = Array.from({ length: 60 }, (_, i) => agent(`p${i}`, 'w1', `Task ${i}`));
  const s = store();
  s.data.features['w2::archive'] = { label: 'Archived work', workspaceId: 'w2', ms: 60000, done: true };
  const app = appFor(addGhosts(world(many, s), s), s);
  app.onKey('a');
  for (let i = 0; i < 60; i++) app.onKey('\x1b[B');
  const selected = app.browserEntries().find((e) => e.id === app.browser.selectedId);
  assert.match(plain(app.render(120, 16)), new RegExp(`› .*${selected.worker.paneId}`));
  app.onKey('\x1b');
  app.onKey('/');
  app.onKey('archived');
  assert.equal(app.browserEntries().length, 1);
  app.onKey('\r');
  assert.equal(app.inspectKey, 'w2::archive');
});

console.log(`\n${checks}/${checks} navigation checks passed`);
