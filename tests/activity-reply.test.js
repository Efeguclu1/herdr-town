'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { recordActivity, summarySince, SummaryCursor, MAX_EVENTS, RETENTION_MS } = require('../src/activity');
const { ReplyDrafts, cleanText, MAX_REPLY } = require('../src/reply');
const { TerminalInput } = require('../src/input');
const { App, width, replyLayout } = require('../src/main');
const { buildWorld } = require('../src/world');

const cases = [];
function test(name, run) { cases.push({ name, run }); }
const workspaces = [
  { workspace_id: 'w1', label: 'Orchard', number: 1 },
  { workspace_id: 'w2', label: 'Harbor', number: 2 },
];
function agent(pane = 'p1', state = 'working', workspace = 'w1', title = 'Login fix', name = 'claude') {
  return { pane_id: pane, agent_status: state, workspace_id: workspace, terminal_title: title, agent: name };
}
function fixture(agents = [agent()]) {
  const store = { data: { features: {} }, workMs: () => 0, entry: () => null, syncFromDisk: () => {} };
  const world = buildWorld({ workspaces, agents, at: Date.now() }, store);
  return { store, world };
}
function appFor(agents, sendPrompt = async () => {}) {
  const { store, world } = fixture(agents);
  const app = new App({ store, sendPrompt, summaryCursor: new SummaryCursor(null),
    messages: { get: () => ({ lines: ['Hello'], at: 1 }), entries: new Map() } });
  app.world = world;
  app.readPaneId = (agents || [agent()])[0].pane_id;
  app.mode = 'read';
  return app;
}
function inputFor(app) {
  return new TerminalInput((e) => {
    if (e.type === 'paste') app.onPaste(e.text, e.truncated);
    else if (e.type === 'mouse') app.onMouse(e.event);
    else if (e.type === 'focus') app.onFocus(e.focused);
    else app.onKey(e.text);
  });
}
function plain(frame) { return frame.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, ''); }
function updates() {
  const baseline = recordActivity(null, fixture().world, 1000);
  return recordActivity(baseline, fixture([agent('p1', 'done'), agent('p2', 'blocked', 'w2', 'Search API')]).world, 16000);
}

test('first observation is a baseline, not fabricated away activity', () => {
  const first = recordActivity(null, fixture([agent('p1', 'blocked')]).world, 1000);
  assert.equal(first.events.length, 0);
  assert.equal(first.seq, 0);
  assert.ok(first.epoch);
  assert.equal(recordActivity(first, fixture([agent('p1', 'blocked')]).world, 16000).events.length, 0);
});

test('records completions, new blocks and changed towns without duplicates', () => {
  const log = updates();
  assert.deepEqual(log.events.map((e) => e.type), ['state', 'started', 'blocked', 'finished']);
  assert.equal(new Set(log.events.map((e) => e.townId)).size, 2);
  const restarted = recordActivity(JSON.parse(JSON.stringify(log)), fixture([agent('p1', 'done'), agent('p2', 'blocked', 'w2', 'Search API')]).world, 31000);
  assert.deepEqual(restarted.events, log.events);
  assert.equal(restarted.epoch, log.epoch);
});

test('records unblocking and departures, retaining context after a workspace closes', () => {
  const log = updates();
  const next = recordActivity(log, fixture([agent('p2', 'working', 'w2', 'Search API')]).world, 31000);
  const changes = summarySince(next, { epoch: log.epoch, seq: log.seq }).events;
  assert.deepEqual(changes.map((e) => e.type), ['unblocked', 'left']);
  assert.equal(changes[1].town, 'Orchard');
  assert.equal(changes[1].task, 'Login fix');
});

test('moving an agent records activity in both its old and new towns', () => {
  const baseline = recordActivity(null, fixture().world, 1000);
  const moved = recordActivity(baseline, fixture([agent('p1', 'working', 'w2', 'Other task')]).world, 16000);
  assert.deepEqual(moved.events.map((e) => [e.type, e.townId]), [['started', 'w2'], ['left', 'w1']]);
});

test('a reset recorder history does not inherit an old acknowledgement', () => {
  const log = updates();
  assert.equal(summarySince(log, { epoch: 'previous history', seq: 99999 }).events.length, log.events.length);
});

test('gaps are explicit and retention is bounded by count and age', () => {
  const baseline = recordActivity(null, fixture().world, 1000);
  baseline.events = Array.from({ length: MAX_EVENTS + 20 }, (_, i) => ({ id: i + 1, at: 1000, type: 'blocked' }));
  baseline.seq = baseline.events.length;
  const capped = recordActivity(baseline, fixture().world, 16000);
  assert.equal(capped.events.length, MAX_EVENTS);
  assert.equal(summarySince(capped, null).truncated, true);
  const expired = recordActivity(capped, fixture().world, RETENTION_MS + 20000);
  assert.deepEqual(expired.events.map((e) => e.type), ['gap']);
  assert.equal(summarySince(expired, null).truncated, true);
});

test('old or malformed stores report history unavailable rather than crashing', () => {
  assert.equal(summarySince(undefined, null).unavailable, true);
  assert.equal(summarySince({ events: 'bad' }, null).unavailable, true);
  assert.equal(recordActivity({ events: 'bad' }, fixture().world, 1000).events.length, 0);
});

test('acknowledgement persists independently, is monotonic, and tolerates corrupt files', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'town-summary-test-'));
  try {
    const file = path.join(dir, 'summary-seen.json');
    const cursor = new SummaryCursor(file);
    cursor.acknowledge('epoch', 5);
    new SummaryCursor(file).acknowledge('epoch', 3);
    assert.deepEqual(new SummaryCursor(file).value, { epoch: 'epoch', seq: 5 });
    fs.writeFileSync(file, '{broken');
    assert.equal(new SummaryCursor(file).value, null);
    assert.deepEqual(fs.readdirSync(dir), ['summary-seen.json']);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('summary is frozen; marking read cannot consume events arriving during reading', () => {
  const app = appFor();
  app.mode = 'world';
  app.store.data.activity = updates();
  app.onKey('s');
  const displayed = app.summary.through;
  app.store.data.activity = recordActivity(app.store.data.activity, fixture([]).world, 31000);
  app.onKey('c');
  assert.equal(app.mode, 'world');
  assert.equal(app.summaryCursor.value.seq, displayed);
  assert.equal(app.unseenSummary().events.length, 2);
  app.onKey('s');
  app.onKey('\x1b');
  assert.equal(app.unseenSummary().events.length, 2); // Esc is not an acknowledgement.
});

test('failed acknowledgements keep the summary unread', () => {
  const app = appFor();
  app.store.data.activity = updates();
  app.openSummary();
  app.summaryCursor.acknowledge = () => { throw new Error('read only'); };
  app.onKey('c');
  assert.equal(app.mode, 'summary');
  assert.match(app.summaryError, /Could not save/);
  assert.equal(app.unseenSummary().events.length, 4);
});

test('return focus offers unread summary but never interrupts editing', () => {
  const app = appFor();
  app.store.data.activity = updates();
  app.mode = 'town';
  app.onFocus(false, 1000);
  app.onFocus(true, 62000);
  assert.equal(app.mode, 'summary');
  app.onKey('\x1b');
  app.mode = 'read';
  app.openReply();
  app.onFocus(false, 1000);
  app.onFocus(true, 62000);
  assert.equal(app.mode, 'read');
  assert.equal(app.replyMode, true);
});

test('multiline editor preserves indentation and edits by Unicode code point', () => {
  const r = new ReplyDrafts();
  r.open({ paneId: 'p1', name: 'claude' });
  r.insert('  a世界\nnext');
  r.key('\x01');
  r.key('\x7f');
  assert.equal(r.text, '  a世界next');
  r.key('\x1b[D');
  r.key('\x1b[3~');
  assert.equal(r.text, '  a世next');
  r.key('\r');
  assert.equal(r.text, '  a世\nnext');
  r.key('\x1b[A');
  assert.equal(r.cursor, 0);
  r.key('\x05');
  assert.equal(r.cursor, 4);
});

test('cursor handles leading blank lines without moving outside the document', () => {
  const r = new ReplyDrafts();
  r.open({ paneId: 'p1', name: 'claude' });
  r.insert('\n\nx');
  r.cursor = 0;
  r.key('\x01');
  assert.equal(r.cursor, 0);
  r.key('\x1b[B');
  assert.equal(r.cursor, 1);
  r.key('\x1b[A');
  assert.equal(r.cursor, 0);
});

test('Esc keeps separate per-agent drafts; a different CLI does not inherit one', () => {
  const app = appFor([agent(), agent('p2', 'working', 'w2')]);
  app.openReply();
  app.onKey('first');
  app.onKey('\x1b');
  app.readPaneId = 'p2';
  app.openReply();
  assert.equal(app.replyText, '');
  app.onKey('second');
  app.onKey('\x1b');
  app.readPaneId = 'p1';
  app.openReply();
  assert.equal(app.replyText, 'first');
  app.reply.open({ paneId: 'p1', name: 'codex' });
  assert.equal(app.replyText, '');
});

test('safe paste is chunk independent, including every UTF-8 byte and embedded commands', () => {
  const payload = '  世界\r\nq\n\x1b[A\x1b[<0;2;3M\x13';
  const bytes = Buffer.from(`\x1b[200~${payload}\x1b[201~`);
  for (const chunk of [1, 2, 3, 7, bytes.length]) {
    const app = appFor();
    app.openReply();
    const input = inputFor(app);
    for (let i = 0; i < bytes.length; i += chunk) input.feed(bytes.subarray(i, i + chunk));
    assert.equal(app.replyText, '  世界\nq\n');
    assert.equal(app.reply.confirming, false);
    assert.equal(app.running, true);
  }
});

test('bracketed paste outside an editor never triggers shortcuts or confirmations', async () => {
  let sends = 0;
  const app = appFor(undefined, async () => { sends++; });
  app.mode = 'town';
  const input = inputFor(app);
  input.feed('\x1b[200~q\r/a\x13\x1b[201~');
  assert.equal(app.mode, 'town');
  assert.equal(app.running, true);
  app.mode = 'read';
  app.openReply();
  app.onKey('safe');
  app.onKey('\x13');
  input.feed('\x1b[200~\r\ny\x1b[201~');
  await Promise.resolve();
  assert.equal(sends, 0);
  assert.equal(app.replyText, 'safe');
});

test('paste and drafts are bounded and strip terminal control sequences', () => {
  const app = appFor();
  app.openReply();
  inputFor(app).feed('\x1b[200~' + 'x'.repeat(MAX_REPLY + 100) + '\x1b[201~');
  assert.equal(app.replyText.length, MAX_REPLY);
  assert.match(app.reply.error, /truncated/);
  assert.equal(cleanText('a\x1b]52;c;secret\x07b\x1b[31mc\t\r\nd'), 'abc  \nd');
});

test('input parser preserves split arrows, bare Escape, focus and mouse events', () => {
  const events = [];
  const input = new TerminalInput((e) => events.push(e));
  input.feed('\x1b[');
  input.flushEscape();
  assert.equal(events.length, 0);
  input.feed('A\x1b[I\x1b[O\x1b[<0;2;3M');
  assert.deepEqual(events.map((e) => e.type), ['key', 'focus', 'focus', 'mouse']);
  assert.equal(events[0].text, '\x1b[A');
  input.feed('\x1b');
  input.flushEscape();
  assert.equal(events[4].text, '\x1b');
});

test('Enter inserts newline; review then confirmation sends exactly the displayed text once', async () => {
  const sent = [];
  let finish;
  const app = appFor(undefined, (pane, text) => {
    sent.push({ pane, text });
    return new Promise((resolve) => { finish = resolve; });
  });
  app.openReply();
  app.onKey('  code');
  app.onKey('\r');
  app.onKey('next  ');
  assert.equal(sent.length, 0);
  app.onKey('\x13');
  assert.equal(app.reply.confirming, true);
  const sending = app.sendReply();
  app.onKey('\r');
  app.onKey('\x1b');
  app.onKey('modified');
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0], { pane: 'p1', text: '  code\nnext  ' });
  assert.equal(app.replyMode, true);
  finish();
  await sending;
  assert.equal(app.replyMode, false);
  assert.equal(app.reply.drafts.has('p1'), false);
});

test('failed delivery retains draft, requires a fresh confirmation, and never auto-retries', async () => {
  let sends = 0;
  const app = appFor(undefined, async () => { sends++; throw new Error('private argv'); });
  app.openReply();
  app.onKey('keep me');
  app.onKey('\x13');
  await app.sendReply();
  assert.equal(app.replyText, 'keep me');
  assert.equal(app.reply.confirming, false);
  assert.match(app.reply.error, /uncertain/);
  assert.doesNotMatch(plain(app.render(120, 24)), /private argv/);
  await app.sendReply();
  assert.equal(sends, 1);
});

test('recipient remains pinned when selection changes; disappearance or replacement blocks sending', async () => {
  const sent = [];
  const app = appFor([agent(), agent('p2')], async (pane) => sent.push(pane));
  app.openReply();
  app.onKey('hello');
  app.onKey('\x13');
  app.readPaneId = 'p2';
  app.world = fixture([agent('p2')]).world;
  await app.sendReply();
  assert.equal(sent.length, 0);
  assert.equal(app.replyText, 'hello');
  assert.match(app.reply.error, /no longer running/);
  app.world = fixture([agent('p1', 'working', 'w1', 'New task', 'codex')]).world;
  app.onKey('\x13');
  assert.equal(app.reply.confirming, false);
});

test('empty replies cannot enter confirmation or send', async () => {
  const app = appFor(undefined, async () => { throw new Error('must not send'); });
  app.openReply();
  app.onKey('  \n');
  app.onKey('\x13');
  assert.equal(app.reply.confirming, false);
  await app.sendReply();
  assert.match(app.reply.error, /Write a message/);
});

test('reply editor wheel scrolling survives repaint without moving the cursor or changing the draft', () => {
  const app = appFor();
  app.openReply();
  app.onPaste(Array.from({ length: 60 }, (_, i) => `Line ${i + 1}`).join('\n'));
  app.render(80, 24);
  const bottom = app.replyScroll;
  const cursor = app.reply.cursor;
  const draft = app.replyText;
  const input = inputFor(app);
  // Exercise the actual streaming mouse path, not just the viewport setter.
  input.feed('\x1b[<64;');
  input.feed('20;10M');
  app.render(80, 24);
  assert.equal(app.replyScroll, bottom - 3);
  app.world = fixture().world; // Refreshed world must not snap the viewport back.
  for (let i = 0; i < 5; i++) app.render(80, 24);
  assert.equal(app.replyScroll, bottom - 3);
  assert.equal(app.reply.cursor, cursor);
  assert.equal(app.replyText, draft);
  input.feed('\x1b[<65;20;10M');
  app.render(80, 24);
  assert.equal(app.replyScroll, bottom);
});

test('Page Up/Down scroll the editor with mouse disabled; typing follows the cursor again', () => {
  const app = appFor();
  app.openReply();
  app.onPaste('long draft\n'.repeat(60));
  app.render(80, 24);
  const bottom = app.replyScroll;
  app.mouseEnabled = false;
  inputFor(app).feed('\x1b[<64;20;10M');
  app.render(80, 24);
  assert.equal(app.replyScroll, bottom);
  app.onKey('\x1b[5~');
  app.render(80, 24);
  assert.ok(app.replyScroll < bottom);
  const pageUp = app.replyScroll;
  app.onKey('\x1b[6~');
  app.render(80, 24);
  assert.ok(app.replyScroll > pageUp);
  for (let i = 0; i < 20; i++) app.onKey('\x1b[5~');
  app.render(80, 24);
  assert.equal(app.replyScroll, 0);
  app.onKey('x');
  app.render(80, 24);
  assert.equal(app.replyScroll, bottom);
  assert.ok(app.replyText.endsWith('\nx'));
});

test('manual scroll stays within bounds and confirmation scrolling still preserves the payload', () => {
  const app = appFor();
  app.openReply();
  app.onPaste('draft line\n'.repeat(50));
  app.render(80, 24);
  for (let i = 0; i < 100; i++) app.onMouse({ name: 'wheel-up', press: true });
  app.render(80, 24);
  assert.equal(app.replyScroll, 0);
  app.render(40, 16); // Resize keeps a manually chosen start rather than following the cursor.
  assert.equal(app.replyScroll, 0);
  app.onKey('\x1b[D');
  app.render(40, 16);
  assert.ok(app.replyScroll > 0);
  const draft = app.replyText;
  app.onKey('\x13');
  app.render(40, 16);
  assert.equal(app.replyScroll, 0);
  app.onKey('\x1bOB'); // Application-cursor arrow variant.
  app.render(40, 16);
  assert.equal(app.replyScroll, 1);
  app.onKey('\x1b[6~');
  app.render(40, 16);
  assert.ok(app.replyScroll > 1);
  app.onKey('\x1b');
  app.render(40, 16);
  assert.equal(app.reply.confirming, false);
  assert.equal(app.replyText, draft);
  app.onKey('\x15');
  app.render(40, 16);
  assert.equal(app.replyScroll, 0);
});

test('streamed wheel events scroll long reading and summary views too', () => {
  const app = appFor();
  app.messages.get = () => ({ lines: Array.from({ length: 80 }, (_, i) => `Message line ${i}`), at: 1 });
  const input = inputFor(app);
  app.render(80, 24);
  input.feed('\x1b[<65;20;10M');
  app.render(80, 24);
  assert.equal(app.readScroll, 3);
  app.render(80, 24);
  assert.equal(app.readScroll, 3);
  app.onKey('\x1b[6~');
  app.render(80, 24);
  assert.ok(app.readScroll > 3);
  app.store.data.activity = updates();
  app.openSummary();
  app.render(40, 16);
  input.feed('\x1b[<65;20;10M');
  app.render(40, 16);
  assert.equal(app.summaryScroll, 3);
  input.feed('\x1b[<64;20;10M');
  app.render(40, 16);
  assert.equal(app.summaryScroll, 0);
});

test('summary, editor and confirmation panels fit small and wide terminals', () => {
  const app = appFor([agent('p1', 'working', 'w1', '世界'.repeat(50))]);
  app.store.data.activity = updates();
  app.openSummary();
  function fits() {
    for (const [cols, rows] of [[40, 16], [80, 24], [120, 40]]) {
      const lines = plain(app.render(cols, rows)).split('\r\n');
      assert.equal(lines.length, rows);
      assert.ok(lines.every((line) => width(line) <= cols));
    }
  }
  fits();
  app.onKey('\x1b');
  app.openReply();
  app.onPaste('  世界'.repeat(60) + '\n\n' + 'many lines\n'.repeat(40));
  fits();
  app.onKey('\x13');
  fits();
  app.onMouse({ name: 'wheel-down', press: true });
  assert.ok(app.replyScroll > 0);
  assert.deepEqual(replyLayout('  a\n\nb', null, 20).lines, ['  a', '', 'b']);
});

(async () => {
  for (const { name, run } of cases) {
    await run();
    console.log(`  ok ${name}`);
  }
  console.log(`\n${cases.length}/${cases.length} activity/reply checks passed`);
})().catch((e) => { console.error(e); process.exitCode = 1; });
