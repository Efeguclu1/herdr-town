'use strict';

const { Canvas } = require('./canvas');
const { P, agentColor, mix } = require('./palette');
const { drawTown, drawWorld, STATE_COLOR } = require('./scene');
const {
  snapshot, focusAgent, promptAgent, sendKeys, readNow,
} = require('./herdr');
const { parseChoices } = require('./choices');
const { Store } = require('./store');
const { AttentionClock, navigationEntries, entriesFor } = require('./navigation');
const { buildWorld, addGhosts, FLOOR_MINUTES, MAX_FLOORS } = require('./world');
const { ensureRecorder } = require('./ensure-recorder');
const { MessageCache } = require('./message');
const mouse = require('./mouse');
const daylight = require('./daylight');

const { SummaryCursor, summarySince } = require('./activity');
const { ReplyDrafts, cleanText } = require('./reply');
const { TerminalInput, ENABLE: INPUT_ENABLE, DISABLE: INPUT_DISABLE } = require('./input');

const HEADER_ROWS = 1;
const LABEL_ROWS = 1;
const FOOTER_ROWS = 2;
const CHROME_ROWS = HEADER_ROWS + LABEL_ROWS + FOOTER_ROWS;
const MIN_ROWS = 16;
const MIN_COLS = 40;

const FRAME_MS = 80;   // ~12fps animation
const POLL_MS = 1000;  // agent state refresh

const argv = process.argv.slice(2);
const ONCE = argv.includes('--once');
// Dev affordance: render the reading view for one pane and exit, so the
// layout can be checked at a known size without driving a live terminal.
const READ_ARG = (argv.find((a) => a.startsWith('--read=')) || '').slice(7);

// ------------------------------------------------------------------ text

function fg(color) {
  return `\x1b[38;2;${(color >> 16) & 255};${(color >> 8) & 255};${color & 255}m`;
}
const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';

// Rough display width: enough to keep CJK titles from overflowing the row.
function charWidth(cp) {
  if (cp >= 0x1100 && (
    cp <= 0x115f
    || (cp >= 0x2e80 && cp <= 0xa4cf)
    || (cp >= 0xac00 && cp <= 0xd7a3)
    || (cp >= 0xf900 && cp <= 0xfaff)
    || (cp >= 0xfe30 && cp <= 0xfe6f)
    || (cp >= 0xff00 && cp <= 0xff60)
    || (cp >= 0xffe0 && cp <= 0xffe6)
    || (cp >= 0x1f300 && cp <= 0x1f64f)
    || (cp >= 0x1f900 && cp <= 0x1f9ff)
  )) return 2;
  return 1;
}

function width(s) {
  let w = 0;
  for (const ch of s) w += charWidth(ch.codePointAt(0));
  return w;
}

function truncate(s, max) {
  const clean = String(s).replace(/[\x00-\x1f\x7f]/g, '');
  if (max <= 0) return '';
  if (width(clean) <= max) return clean;
  let out = '';
  let w = 0;
  for (const ch of clean) {
    const cw = charWidth(ch.codePointAt(0));
    if (w + cw > max - 1) break;
    out += ch;
    w += cw;
  }
  return out + '…';
}

function pad(s, target) {
  const w = width(s);
  return w >= target ? s : s + ' '.repeat(target - w);
}

function center(s, target) {
  const w = width(s);
  if (w >= target) return truncate(s, target);
  const left = Math.floor((target - w) / 2);
  return ' '.repeat(left) + s + ' '.repeat(target - w - left);
}

// Display-width aware greedy wrap for the reading view. Long unbroken tokens
// (paths, URLs, hashes) are hard-split rather than allowed to overflow.
function wrapText(s, max) {
  const clean = String(s).replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '').replace(/\t/g, '  ');
  if (width(clean) <= max) return [clean];
  const out = [];
  let cur = '';
  for (const word of clean.split(' ')) {
    const candidate = cur ? `${cur} ${word}` : word;
    if (width(candidate) <= max) { cur = candidate; continue; }
    if (cur) out.push(cur);
    cur = word;
    while (width(cur) > max) {
      let take = '';
      for (const ch of cur) {
        if (width(take + ch) > max) break;
        take += ch;
      }
      out.push(take);
      cur = cur.slice(take.length);
    }
  }
  if (cur) out.push(cur);
  return out.length ? out : [''];
}

function humanDuration(ms) {
  const m = Math.floor(ms / 60000);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  const rem = m % 60;
  return rem ? `${h}h${rem}m` : `${h}h`;
}

// Hard-wrap the editor without collapsing indentation or blank lines.
function replyLayout(text, cursor, cols) {
  const lines = [''];
  let column = 0;
  let cursorRow = 0;
  function put(ch) {
    if (ch === '\n') { lines.push(''); column = 0; return; }
    const size = charWidth(ch.codePointAt(0));
    if (column + size > cols) { lines.push(''); column = 0; }
    lines[lines.length - 1] += ch;
    column += size;
  }
  const chars = [...text];
  for (let i = 0; i <= chars.length; i++) {
    if (cursor === i) { put('▌'); cursorRow = lines.length - 1; }
    if (i < chars.length) put(chars[i]);
  }
  return { lines, cursorRow };
}

// ------------------------------------------------------------------ app

class App {
  constructor({ store = new Store({ readOnly: true }), messages = new MessageCache(),
    summaryCursor = new SummaryCursor(null), sendPrompt = promptAgent } = {}) {
    this.store = store;
    // What each agent last said. Fetched behind the render loop, never in it.
    this.messages = messages;
    this.world = { towns: [], at: 0 };
    this.frame = 0;
    this.mode = 'town'; // town | world | read | relay | browse | inspect | summary
    this.townIndex = 0;
    this.scroll = 0;
    this.selectedPaneId = null;
    this.error = null;
    this.lastPoll = 0;
    this.status = '';
    this.statusUntil = 0;
    this.running = true;
    this.pendingFocus = null;
    // Reading view state. Initialised here as well as in openRead(), because
    // an undefined scroll turns the slice bounds into NaN and renders nothing.
    this.readPaneId = null;
    this.readScroll = 0;
    this.readReturnMode = 'town';
    this.attentionClock = new AttentionClock();
    this.browser = null;
    this.inspectKey = null;
    this.inspectScroll = 0;
    this.summaryCursor = summaryCursor;
    this.summary = null;
    this.summaryScroll = 0;
    this.summaryReturnMode = 'town';
    this.awayAt = null;
    this.polling = false;
    // Worker rectangles from the last rendered frame, in canvas pixels.
    this.hitRects = [];
    this.mouseEnabled = true;
    // Reply composer, only reachable from the reading view.
    this.replyMode = false;
    this.reply = new ReplyDrafts();
    this.replyScroll = 0;
    this.replyFollowCursor = true;
    this.replyPageRows = 10;
    this.replyMaxScroll = Infinity;
    this.sendPrompt = sendPrompt;
    // Agent-to-agent relay. The worker being read is the sender; `t` opens a
    // cross-town recipient picker, then a dedicated composer. Herdr delivers
    // the resulting envelope straight to the recipient pane.
    this.relayRecipientIndex = 0;
    this.relayRecipientPaneId = null;
    this.relayCompose = false;
    this.relayText = '';
    this.relaySending = false;
    // Parsed multiple-choice prompt for the pane being read, memoised on the
    // cache entry's timestamp so it is not re-parsed every frame.
    this.choices = null;
    this.choicesFor = null;
    this.answering = false;
    // Herdr injects the launching workspace, so opening the view from a
    // project drops you in that project's town rather than the first one.
    this.selectedTownId = process.env.HERDR_WORKSPACE_ID || null;
  }

  get town() {
    return this.world.towns[this.townIndex] || null;
  }

  // Flatten the current town into a left-to-right list of workers, which is
  // what the arrow keys walk through. Buildings are re-sorted on every poll,
  // so entries carry the pane id and selection is tracked by that, never by
  // position.
  selectionList() {
    const t = this.town;
    if (!t) return [];
    const out = [];
    t.buildingList.forEach((b, bi) => {
      b.workers.forEach((w, wi) => out.push({
        paneId: w.paneId, buildingIndex: bi, workerIndex: wi, worker: w, building: b,
      }));
    });
    return out;
  }

  // Every live worker in every town. Relay recipients are deliberately not
  // limited to the current workspace: the world view already establishes
  // that Agent Town spans all of Herdr.
  allWorkers() {
    const out = [];
    for (const town of this.world.towns) {
      for (const building of town.buildingList) {
        for (const worker of building.workers) {
          out.push({ paneId: worker.paneId, worker, building, town });
        }
      }
    }
    return out;
  }

  relayRecipients() {
    return this.allWorkers().filter((e) => e.paneId !== this.readPaneId);
  }

  selectedEntry() {
    const list = this.selectionList();
    if (!list.length) return null;
    return list.find((e) => e.paneId === this.selectedPaneId) || list[0];
  }

  // Where the selected worker currently sits, recomputed each frame so a
  // re-sort moves the marker with the worker instead of stranding it.
  selectionIndices() {
    const e = this.selectedEntry();
    return e ? { buildingIndex: e.buildingIndex, workerIndex: e.workerIndex } : null;
  }

  moveSelection(delta) {
    const list = this.selectionList();
    if (!list.length) return;
    let idx = list.findIndex((e) => e.paneId === this.selectedPaneId);
    if (idx < 0) idx = 0;
    idx = Math.max(0, Math.min(list.length - 1, idx + delta));
    this.selectedPaneId = list[idx].paneId;
  }

  changeTown(delta) {
    if (!this.world.towns.length) return;
    const n = this.world.towns.length;
    this.townIndex = ((this.townIndex + delta) % n + n) % n;
    this.scroll = 0;
    // Pin the new town by id, or the next poll will snap us back to the old one.
    this.selectedTownId = this.town ? this.town.id : null;
    const first = this.selectionList()[0];
    this.selectedPaneId = first ? first.paneId : null;
  }

  setStatus(text, ms = 2500) {
    this.status = text;
    this.statusUntil = Date.now() + ms;
  }

  async poll() {
    if (this.polling) return;
    this.polling = true;
    try {
      const snap = await snapshot();
      // The background recorder owns build progress; the view just reads
      // whatever it has written, then raises the standing skyline of features
      // whose agents have since gone.
      this.store.syncFromDisk();
      this.world = addGhosts(buildWorld(snap, this.store), this.store);
      this.attentionClock.update(this.world);
      this.error = null;

      // Follow the selected town by id, so it survives workspaces being
      // created, closed or reordered between polls.
      if (this.selectedTownId) {
        const i = this.world.towns.findIndex((t) => t.id === this.selectedTownId);
        if (i >= 0) this.townIndex = i;
      }
      if (this.townIndex >= this.world.towns.length) this.townIndex = 0;
      this.selectedTownId = this.town ? this.town.id : null;

      this.messages.retain(snap.agents.map((a) => a.pane_id));

      // Only fall back when the selected worker is genuinely gone.
      const list = this.selectionList();
      if (list.length && !list.some((e) => e.paneId === this.selectedPaneId)) {
        this.selectedPaneId = list[0].paneId;
      }

      // Warm the panes the arrow keys can reach next, so moving the selection
      // shows a message immediately instead of "reading screen…". Neighbours
      // only: prefetching every agent would spawn a read per pane per TTL.
      const idx = list.findIndex((e) => e.paneId === this.selectedPaneId);
      if (idx >= 0) {
        for (const d of [0, 1, -1]) {
          const e = list[idx + d];
          if (e) this.messages.get(e.paneId);
        }
      }
    } catch (e) {
      this.error = e.message || String(e);
    } finally {
      this.polling = false;
    }
  }

  // ----------------------------------------------------------- away summary

  unseenSummary() {
    return summarySince(this.store.data && this.store.data.activity, this.summaryCursor.value);
  }

  offerSummary() {
    const unseen = this.unseenSummary();
    if (!this.replyMode && ['town', 'world'].includes(this.mode)
      && (unseen.events.length || unseen.truncated)) this.openSummary();
  }

  onFocus(focused, now = Date.now()) {
    if (!focused) this.awayAt = now;
    else {
      if (this.awayAt !== null && now - this.awayAt >= 60000) this.offerSummary();
      this.awayAt = null;
    }
  }

  openSummary() {
    this.store.syncFromDisk();
    this.summaryCursor.load();
    if (this.mode !== 'summary') this.summaryReturnMode = this.mode;
    // Freeze the displayed range: acknowledging it must not consume events
    // arriving in the background while the user is still reading.
    this.summary = this.unseenSummary();
    this.summaryScroll = 0;
    this.summaryError = '';
    this.mode = 'summary';
  }

  acknowledgeSummary() {
    if (!this.summary || this.summary.unavailable) return;
    try {
      this.summaryCursor.acknowledge(this.summary.epoch, this.summary.through);
      this.mode = this.summaryReturnMode;
      this.setStatus('displayed summary marked read');
    } catch {
      this.summaryError = 'Could not save acknowledgement. Updates remain unread.';
    }
  }

  renderSummary(cols, rows) {
    const summary = this.summary;
    const text = [];
    if (summary.unavailable) {
      text.push('Activity history is not available yet.', '',
        'Start or restart the recorder to enable summaries. Its first snapshot establishes a baseline; later changes appear here.');
    } else {
      const events = summary.events;
      const changed = new Set(events.filter((e) => e.townId).map((e) => e.townId));
      text.push(`${events.filter((e) => e.type === 'finished').length} feature completions · ${events.filter((e) => e.type === 'blocked').length} blocks · ${changed.size} towns changed`,
        'Since last marked read. Observation times, not exact transition times.',
        `Recorder last observed: ${new Date(summary.lastRecorded).toLocaleString()}`);
      if (Date.now() - summary.lastRecorded > 60000) text.push('Recorder data is stale. Recent changes may be missing.');
      if (summary.truncated) text.push('Some older updates expired (7 days / 1,000 events). This summary is incomplete.');
      if (!events.length) text.push('', 'No retained unread changes.');
      const gaps = events.filter((e) => e.type === 'gap');
      for (const gap of gaps) text.push(`Recording gap: ${new Date(gap.since).toLocaleString()} → ${new Date(gap.at).toLocaleString()}. Intermediate changes may be missing.`);
      const towns = new Map();
      for (const event of events) {
        if (!event.townId) continue;
        if (!towns.has(event.townId)) towns.set(event.townId, []);
        towns.get(event.townId).push(event);
      }
      const labels = { started: 'agent appeared / changed task', blocked: 'became blocked',
        unblocked: 'left blocked state', state: 'agent state changed', finished: 'feature observed done', left: 'agent left task' };
      for (const list of towns.values()) {
        text.push('', `${list[list.length - 1].town}:`);
        for (const event of list) {
          text.push(`  ${new Date(event.at).toLocaleString()} · ${labels[event.type] || event.type}`,
            `    ${event.task}${event.name ? ` · ${event.name} (${event.paneId}) · ${event.state}` : ''}`);
        }
      }
    }
    const body = text.flatMap((line) => wrapText(line, Math.max(1, cols - 2))).map((line) => ` ${line}`);
    const capacity = rows - 4;
    this.summaryScroll = Math.max(0, Math.min(this.summaryScroll, body.length - capacity));
    return this.renderPanel(cols, rows, 'WHILE YOU WERE AWAY', body.slice(this.summaryScroll),
      'c mark read · r refresh · esc back', this.summaryError || `↑↓/wheel scroll · ${this.summaryScroll + 1}-${Math.min(body.length, this.summaryScroll + capacity)} of ${body.length}`);
  }

  // ---------------------------------------------------------- navigation

  openBrowser(kind) {
    this.browser = {
      kind, query: '', townId: this.town && this.town.id,
      returnMode: this.mode, selectedId: null,
    };
    this.mode = 'browse';
    const entries = this.browserEntries();
    const selected = kind === 'buildings' && this.selectedEntry();
    this.browser.selectedId = selected ? `building:${selected.building.key}` : (entries[0] || {}).id;
  }

  browserEntries() {
    return navigationEntries(this.world, { ...this.browser, clock: this.attentionClock });
  }

  moveBrowser(delta) {
    const entries = this.browserEntries();
    if (!entries.length) return;
    const current = entries.findIndex((e) => e.id === this.browser.selectedId);
    const next = current < 0 ? 0 : Math.max(0, Math.min(entries.length - 1, current + delta));
    this.browser.selectedId = entries[next].id;
  }

  browserKey(s) {
    if (s === '\x03') { this.running = false; return; }
    if (s === '\x1b') { this.mode = this.browser.returnMode; return; }
    if (s === '\x1b[A' || s === '\x1bOA') { this.moveBrowser(-1); return; }
    if (s === '\x1b[B' || s === '\x1bOB') { this.moveBrowser(1); return; }
    if (s === '\x1b[5~') { this.moveBrowser(-10); return; }
    if (s === '\x1b[6~') { this.moveBrowser(10); return; }
    if (s === '\r' || s === '\n') {
      const e = this.browserEntries().find((x) => x.id === this.browser.selectedId);
      if (!e) return; // Never redirect an action when a poll removes its target.
      if (e.kind === 'building') {
        this.inspectKey = e.building.key;
        this.inspectScroll = 0;
        this.mode = 'inspect';
      } else {
        this.townIndex = this.world.towns.findIndex((t) => t.id === e.town.id);
        this.selectedTownId = e.town.id;
        this.scroll = 0;
        if (e.worker) {
          this.selectedPaneId = e.worker.paneId;
          this.readPaneId = e.worker.paneId;
          this.readScroll = 0;
          this.readReturnMode = 'browse';
          this.choices = null;
          this.choicesFor = null;
          this.mode = 'read';
        } else this.mode = 'town';
      }
      return;
    }
    const before = this.browser.query;
    if (s === '\x7f' || s === '\b') this.browser.query = [...before].slice(0, -1).join('');
    else if (s === '\x15') this.browser.query = '';
    else if (!s.startsWith('\x1b')) {
      this.browser.query += [...s].filter((ch) => ch.codePointAt(0) >= 0x20
        && ch.codePointAt(0) !== 0x7f).join('');
    }
    if (before !== this.browser.query) this.browser.selectedId = (this.browserEntries()[0] || {}).id;
  }

  // Plain, clipped rows prevent long workspace names or terminal control
  // characters in titles from escaping these panels. Colour only after clipping.
  renderPanel(cols, rows, title, body, help, status = '') {
    const lines = [fg(P.cyan) + BOLD + truncate(` ${title}`, cols) + RESET,
      fg(P.dark) + '─'.repeat(cols) + RESET];
    for (const text of body.slice(0, rows - 4)) {
      lines.push(fg(text.startsWith(' ›') ? P.lime : P.white) + truncate(text, cols) + RESET);
    }
    while (lines.length < rows - 2) lines.push('');
    lines.push(fg(this.error ? P.red : P.slate)
      + truncate(` ${this.error ? `herdr: ${this.error} (showing last snapshot)` : status}`, cols) + RESET);
    lines.push(fg(P.grey) + truncate(` ${help}`, cols) + RESET);
    return `\x1b[H${lines.join('\x1b[K\r\n')}\x1b[K`;
  }

  renderBrowser(cols, rows) {
    const b = this.browser;
    const entries = this.browserEntries();
    const index = entries.findIndex((e) => e.id === b.selectedId);
    const capacity = Math.max(1, rows - 5);
    const start = Math.max(0, Math.min(index - Math.floor(capacity / 2), entries.length - capacity));
    const body = [` / ${b.query || '(type to filter)'}`];
    for (const e of entries.slice(start, start + capacity)) {
      let text;
      if (e.worker) {
        const since = this.attentionClock.since.get(e.worker.paneId);
        const wait = b.kind === 'attention' ? ` · observed ${humanDuration(Math.max(0, Date.now() - since))}` : '';
        text = `${e.worker.name} · ${e.worker.state}${wait} · ${e.building.label} · ${e.town.label} · ${e.worker.paneId}`;
      } else if (e.building) text = `${e.building.label} · ${e.building.state} · ${e.town.label}`;
      else text = `${e.town.label} · ${e.town.agentCount} agents`;
      body.push(` ${e.id === b.selectedId ? '›' : ' '} [${e.kind}] ${text}`);
    }
    if (!entries.length) body.push(b.query ? ' No matches. Ctrl+U clears the filter.'
      : b.kind === 'attention' ? ' No blocked agents across any town.' : ' Nothing here yet.');
    const titles = { attention: 'ATTENTION · oldest observed first', buildings: 'BUILDINGS · live and historical', search: 'SEARCH · all towns' };
    const status = index < 0 && entries.length ? 'Selection left this list. Use arrows to select again.'
      : `${entries.length} result${entries.length === 1 ? '' : 's'}${index >= 0 ? ` · ${index + 1}/${entries.length}` : ''}`;
    return this.renderPanel(cols, rows, titles[b.kind], body,
      '↑↓ select · enter open · esc back · ^U clear', status);
  }

  renderInspector(cols, rows) {
    const e = entriesFor(this.world).find((x) => x.kind === 'building' && x.building.key === this.inspectKey);
    if (!e) return this.renderPanel(cols, rows, 'BUILDING INSPECTOR',
      [' This building is no longer available.'], 'esc back');
    const b = e.building;
    const saved = this.store.entry(b.key) || {};
    const date = (value) => value ? new Date(value).toLocaleString() : 'not recorded';
    const contributors = [...(saved.contributors || [])];
    for (const w of b.workers) {
      if (!contributors.some((c) => c.paneId === w.paneId && c.name === w.name)) contributors.push(w);
    }
    const text = [b.label, `Town: ${e.town.label}`, `Status: ${b.state}${b.standing ? ' (historical)' : ''}`,
      `Agent working time: ${humanDuration(b.workMs)} · ${b.floors}/${MAX_FLOORS} floors`,
      'Working time is not completion percentage.',
      `First recorded observation: ${date(saved.firstObserved)}`,
      `Last recorded activity: ${date(saved.seen)}`,
      `Previously observed done: ${saved.done ? 'yes' : 'not recorded'}`, '',
      'Live agents:', ...b.workers.map((w) => `  ${w.name} · ${w.state} · ${w.paneId}`),
      ...(b.workers.length ? [] : ['  none']), '', 'Recorded contributors (plus live agents):',
      ...contributors.map((w) => `  ${w.name} · ${w.paneId}`),
      ...(contributors.length ? [] : ['  not recorded']), '',
      'Contributor and first-observation history starts with this release.'];
    const body = text.flatMap((line) => wrapText(line, Math.max(1, cols - 2))).map((line) => ` ${line}`);
    const capacity = rows - 4;
    this.inspectScroll = Math.max(0, Math.min(this.inspectScroll, body.length - capacity));
    return this.renderPanel(cols, rows, 'BUILDING INSPECTOR', body.slice(this.inspectScroll),
      '↑↓/wheel scroll · esc back', `${this.inspectScroll + 1}-${Math.min(body.length, this.inspectScroll + capacity)} of ${body.length}`);
  }

  // ---------------------------------------------------------------- draw

  // Open the full message for the selected worker. The town keeps running
  // underneath; this is a mode, not a new process.
  openRead() {
    const e = this.selectedEntry();
    if (!e) return;
    this.readReturnMode = 'town';
    this.mode = 'read';
    this.readPaneId = e.paneId;
    this.readScroll = 0;
  }

  get replyText() { return this.reply.text; }

  openReply() {
    const e = this.allWorkers().find((x) => x.paneId === this.readPaneId);
    if (!e || this.reply.sending) return;
    this.reply.open({ paneId: e.paneId, name: e.worker.name, townId: e.town.id, town: e.town.label, task: e.building.label });
    this.replyMode = true;
    this.replyScroll = 0;
    this.replyFollowCursor = true;
    this.replyMaxScroll = Infinity;
  }

  // Scrolling is viewport navigation, not cursor movement. Following the
  // insertion point on every repaint would immediately undo a wheel/page event.
  scrollReply(delta) {
    if (this.reply.sending) return;
    this.replyFollowCursor = false;
    this.replyScroll = Math.max(0, Math.min(this.replyMaxScroll, this.replyScroll + delta));
  }

  replyTarget() {
    const t = this.reply.target;
    return t && this.allWorkers().find((e) => e.paneId === t.paneId
      && e.worker.name === t.name && e.town.id === t.townId);
  }

  replyKey(s) {
    const r = this.reply;
    if (r.sending) return; // Freeze the exact reviewed payload until delivery finishes.
    if (s === '\x1b' || s === '\x03') {
      if (r.confirming) { r.confirming = false; this.replyFollowCursor = true; }
      else { r.save(); this.replyMode = false; this.setStatus('draft kept for this agent (this session)'); }
      return;
    }
    if (s === '\x1b[5~' || s === '\x1b[6~') {
      this.scrollReply((s === '\x1b[5~' ? -1 : 1) * this.replyPageRows);
      return;
    }
    if (r.confirming) {
      if (s === '\r' || s === '\n') this.sendReply();
      else if (s === '\x1b[A' || s === '\x1bOA') this.scrollReply(-1);
      else if (s === '\x1b[B' || s === '\x1bOB') this.scrollReply(1);
      return;
    }
    if (s === '\x13') { // Ctrl+S reviews; Enter only inserts a newline while editing.
      if (!r.text.trim()) { r.error = 'Write a message before reviewing.'; return; }
      if (!this.replyTarget()) { r.error = 'Agent no longer running. Draft kept; nothing sent.'; return; }
      r.confirming = true;
      r.error = '';
      this.replyScroll = 0;
      this.replyFollowCursor = false;
      return;
    }
    // Resume following when the user edits or deliberately moves the cursor,
    // even when a movement key hits a document boundary.
    this.replyFollowCursor = true;
    r.key(s);
  }

  onPaste(text, truncated = false) {
    if (this.replyMode) {
      // Even a pasted Enter at confirmation is text, never permission to send.
      if (!this.reply.confirming && !this.reply.sending) this.replyFollowCursor = true;
      this.reply.insert(text);
      if (truncated) this.reply.error = 'Paste truncated to the draft size limit.';
    } else if (this.relayCompose && !this.relaySending) {
      this.relayText += cleanText(text).replace(/\n/g, ' ');
    } else this.setStatus('paste ignored outside an editor');
  }

  async sendReply() {
    const r = this.reply;
    if (!this.replyMode || !r.confirming || r.sending || !r.text.trim()) return;
    if (!this.replyTarget()) {
      r.error = 'Agent no longer running. Draft kept; nothing sent.';
      r.confirming = false;
      this.replyFollowCursor = true;
      return;
    }
    const { paneId } = r.target;
    const text = r.text; // Preserve indentation and newlines exactly as reviewed.
    r.sending = true;
    try {
      await this.sendPrompt(paneId, text);
      r.drafts.delete(paneId);
      r.text = '';
      r.cursor = 0;
      r.confirming = false;
      this.replyMode = false;
      this.setStatus(`sent to ${paneId}`, 3000);
      this.messages.entries.delete(paneId);
    } catch {
      // Do not echo argv (which contains the private draft) from execFile errors.
      r.error = 'Delivery failed or uncertain. Draft kept; check agent before retrying.';
      r.confirming = false;
      this.replyFollowCursor = true;
      r.save();
    } finally {
      r.sending = false;
    }
  }

  renderReply(cols, rows) {
    const r = this.reply;
    const t = r.target;
    const target = this.replyTarget();
    const layout = replyLayout(r.text, r.confirming ? null : r.cursor, cols - 2);
    const capacity = Math.max(1, rows - 7);
    this.replyPageRows = Math.max(1, capacity - 1);
    if (!r.confirming && this.replyFollowCursor) {
      if (layout.cursorRow < this.replyScroll) this.replyScroll = layout.cursorRow;
      if (layout.cursorRow >= this.replyScroll + capacity) this.replyScroll = layout.cursorRow - capacity + 1;
    }
    this.replyMaxScroll = Math.max(0, layout.lines.length - capacity);
    this.replyScroll = Math.max(0, Math.min(this.replyScroll, this.replyMaxScroll));
    const body = [` To: ${t.name} · ${t.paneId} · ${t.town}`, ` Task: ${t.task}`,
      r.confirming ? ' Review message below. Nothing sent yet.' : ' Enter: newline · PgUp/PgDn/wheel: scroll',
      ...layout.lines.slice(this.replyScroll, this.replyScroll + capacity).map((line) => ` ${line}`)];
    const status = r.sending ? 'Sending… editor locked until delivery finishes.'
      : r.error || (!target ? 'Agent no longer running. Draft kept; cannot send.'
        : `rows ${this.replyScroll + 1}-${Math.min(layout.lines.length, this.replyScroll + capacity)}/${layout.lines.length} · ${!r.confirming && !this.replyFollowCursor ? 'arrows or typing return to cursor' : `${[...r.text].length} chars · draft kept on Esc`}`);
    return this.renderPanel(cols, rows, r.confirming ? 'CONFIRM REPLY' : 'WRITE REPLY', body,
      r.sending ? 'Please wait…' : r.confirming ? 'enter send · esc edit · ↑↓ scroll' : '^S review · esc keep draft · ^U clear', status);
  }

  openRelay() {
    const recipients = this.relayRecipients();
    if (!recipients.length) {
      this.setStatus('no other agents are running', 3500);
      return;
    }
    this.mode = 'relay';
    this.relayRecipientIndex = 0;
    this.relayRecipientPaneId = null;
    this.relayCompose = false;
    this.relayText = '';
  }

  async sendRelay() {
    const text = this.relayText.trim();
    const source = this.allWorkers().find((e) => e.paneId === this.readPaneId);
    const recipients = this.relayRecipients();
    const target = recipients.find((e) => e.paneId === this.relayRecipientPaneId);
    if (!text || !source || !target || this.relaySending) return;

    const envelope = `[Herdr Town message from ${source.worker.name} (${source.paneId})]\n${text}`;
    this.relaySending = true;
    try {
      await promptAgent(target.paneId, envelope);
      this.relayText = '';
      this.relayCompose = false;
      this.relayRecipientPaneId = null;
      this.mode = 'read';
      this.setStatus(`relayed ${source.worker.name} → ${target.worker.name}`, 4000);
      this.messages.entries.delete(target.paneId);
    } catch (e) {
      const raw = (e.message || '').split('\n')[0];
      const clean = /^Command failed/.test(raw) ? 'agent did not accept the prompt' : raw;
      this.setStatus(`could not relay: ${clean}`, 5000);
    } finally {
      this.relaySending = false;
    }
  }

  // A prompt is only offered when Herdr says the agent is blocked. Herdr's
  // detection is manifest-driven and field-tested across 19 agents; this only
  // decides what the options are, never whether a prompt exists.
  updateChoices(entry, worker) {
    const stamp = entry ? `${worker.paneId}:${entry.at}` : null;
    if (stamp === this.choicesFor) return;
    this.choicesFor = stamp;
    this.choices = (entry && entry.raw && worker.state === 'blocked')
      ? parseChoices(entry.raw)
      : null;
  }

  // Answer a prompt by sending the key the agent printed beside that option.
  //
  // The screen is re-read first and the parse compared against what was on
  // display. A cached screen can be seconds old, and sending a keystroke into
  // a prompt that has already moved on is how you approve something nobody
  // chose. If anything has shifted, refuse and say so.
  async answerChoice(index) {
    const paneId = this.readPaneId;
    const shown = this.choices;
    if (!shown || !shown.options[index] || this.answering || !paneId) return;
    if (!this.allWorkers().some((e) => e.paneId === paneId && e.worker.state === 'blocked')) return;
    const option = shown.options[index];

    this.answering = true;
    this.setStatus(`checking the prompt before sending "${option.key}"…`, 4000);
    try {
      const fresh = parseChoices(await readNow(paneId));
      if (!fresh || fresh.signature !== shown.signature) {
        this.setStatus('prompt changed since it was shown — nothing sent', 5000);
        return;
      }
      await sendKeys(paneId, option.key);
      this.setStatus(`sent "${option.key}" · ${option.label.slice(0, 44)}`, 4000);
      this.messages.entries.delete(paneId);
      this.choicesFor = null;
      this.choices = null;
    } catch (e) {
      const raw = (e.message || '').split('\n')[0];
      this.setStatus(`could not answer: ${/^Command failed/.test(raw) ? 'agent refused the key' : raw}`, 5000);
    } finally {
      this.answering = false;
    }
  }

  render(cols, rows) {
    if (this.replyMode) return this.renderReply(cols, rows);
    if (this.mode === 'summary') return this.renderSummary(cols, rows);
    if (this.mode === 'browse') return this.renderBrowser(cols, rows);
    if (this.mode === 'inspect') return this.renderInspector(cols, rows);
    if (this.mode === 'read') return this.renderRead(cols, rows);
    if (this.mode === 'relay') return this.renderRelay(cols, rows);

    const canvasRows = rows - CHROME_ROWS;
    const cv = new Canvas(cols, canvasRows * 2, P.black);
    // One sky per frame, shared by every draw call and the header.
    this.sky = daylight.current();

    let labelRow;
    if (this.mode === 'world') {
      const { slots } = drawWorld(cv, this.world.towns, {
        frame: this.frame,
        selectedTown: this.townIndex,
        sky: this.sky,
      });
      labelRow = this.worldLabels(slots, cols);
    } else {
      const t = this.town;
      if (!t) {
        drawTown(cv, { buildingList: [] }, {
          frame: this.frame, scroll: 0, selected: null, sky: this.sky,
        });
        this.hitRects = [];
        labelRow = pad('', cols);
      } else {
        const sel = this.selectionIndices();
        const res = drawTown(cv, t, {
          frame: this.frame,
          scroll: this.scroll,
          selected: sel,
          sky: this.sky,
          // Cache lookup only; the scene never waits on a fetch.
          messageFor: (paneId) => {
            const m = this.messages.get(paneId);
            return m ? (m.detail || m.summary || '') : '';
          },
        });
        this.scroll = res.scroll;
        this.hitRects = res.hits;
        labelRow = this.townLabels(res.lots, cols, sel);
      }
    }

    const lines = [this.header(cols), ...cv.render(), labelRow, ...this.footer(cols)];
    return `\x1b[H${lines.join('\x1b[K\r\n')}\x1b[K`;
  }

  renderRelay(cols, rows) {
    const source = this.allWorkers().find((e) => e.paneId === this.readPaneId);
    const recipients = this.relayRecipients();
    if (!source || !recipients.length) { this.mode = 'read'; return this.render(cols, rows); }
    this.relayRecipientIndex = Math.max(0, Math.min(this.relayRecipientIndex, recipients.length - 1));
    const target = this.relayCompose
      ? recipients.find((e) => e.paneId === this.relayRecipientPaneId)
      : recipients[this.relayRecipientIndex];
    if (!target) {
      this.relayCompose = false;
      this.relayRecipientPaneId = null;
      this.relayRecipientIndex = 0;
      this.setStatus('recipient is no longer running', 3500);
      return this.renderRelay(cols, rows);
    }
    const lines = [];
    lines.push(` ${fg(P.cyan)}${BOLD}AGENT RELAY${RESET}  ${fg(P.white)}${source.worker.name}${RESET}${fg(P.dark)} (${source.paneId})${RESET} ${fg(P.slate)}→${RESET} ${fg(P.white)}${target.worker.name}${RESET}${fg(P.dark)} (${target.paneId})${RESET}`);
    lines.push(`${fg(P.dark)}${'─'.repeat(cols)}${RESET}`);

    if (this.relayCompose) {
      const inner = Math.max(20, cols - 4);
      const wrapped = wrapText(this.relayText || '', inner);
      lines.push(`  ${fg(P.slate)}Message delivered with sender name and pane ID:${RESET}`);
      lines.push('');
      for (const piece of wrapped.slice(-(Math.max(1, rows - 7)))) {
        lines.push(`  ${fg(P.white)}${piece}${RESET}`);
      }
      while (lines.length < rows - 2) lines.push('');
      lines.push(this.relaySending
        ? ` ${fg(P.cyan)}sending…${RESET}`
        : ` ${fg(P.lime)}▌${RESET}`);
      lines.push(` ${fg(P.white)}enter${RESET}${fg(P.slate)} send${RESET}${fg(P.dark)}  ${RESET}${fg(P.white)}esc${RESET}${fg(P.slate)} recipients${RESET}${fg(P.dark)}  ${RESET}${fg(P.white)}ctrl+u${RESET}${fg(P.slate)} clear${RESET}`);
    } else {
      const bodyRows = Math.max(3, rows - 4);
      const start = Math.max(0, Math.min(this.relayRecipientIndex - Math.floor(bodyRows / 2), recipients.length - bodyRows));
      for (let i = start; i < Math.min(recipients.length, start + bodyRows); i++) {
        const e = recipients[i];
        const selected = i === this.relayRecipientIndex;
        const marker = selected ? `${fg(P.lime)}›${RESET}` : ' ';
        const town = truncate(e.town.label, 20);
        const task = truncate(e.building.label, Math.max(10, cols - width(town) - width(e.worker.name) - 22));
        lines.push(` ${marker} ${selected ? BOLD + fg(P.white) : fg(P.grey)}${e.worker.name}${RESET} ${fg(STATE_COLOR[e.worker.state] || P.grey)}${e.worker.state}${RESET} ${fg(P.slate)}${task}${RESET} ${fg(P.dark)}· ${town} · ${e.paneId}${RESET}`);
      }
      while (lines.length < rows - 2) lines.push('');
      lines.push(` ${fg(P.grey)}${recipients.length} possible recipient${recipients.length === 1 ? '' : 's'} across all towns${RESET}`);
      lines.push(` ${fg(P.white)}↑↓${RESET}${fg(P.slate)} choose${RESET}${fg(P.dark)}  ${RESET}${fg(P.white)}enter${RESET}${fg(P.slate)} write message${RESET}${fg(P.dark)}  ${RESET}${fg(P.white)}esc${RESET}${fg(P.slate)} back${RESET}`);
    }
    return `\x1b[H${lines.slice(0, rows).join('\x1b[K\r\n')}\x1b[K`;
  }

  // The reading view. Deliberately real terminal text rather than the 3x5
  // pixel font: bubbles are for three words, paragraphs need actual glyphs.
  renderRead(cols, rows) {
    const e = this.allWorkers().find((x) => x.paneId === this.readPaneId);
    if (!e) {
      this.choices = null;
      this.choicesFor = null;
      return this.renderPanel(cols, rows, 'AGENT NO LONGER RUNNING',
        ['The selected pane is gone. No other agent has been selected.'], 'esc back');
    }

    const w = e.worker;
    const msg = this.messages.get(w.paneId);
    this.updateChoices(msg, w);
    const choices = this.choices;
    const inner = Math.max(20, cols - 4);
    // Answerable options take the bottom of the panel, above the key hints.
    const choiceRows = choices ? choices.options.length + 2 : 0;
    const bodyRows = Math.max(3, rows - 4 - choiceRows);

    let body = [];
    if (msg && msg.lines && msg.lines.length) {
      for (const raw of msg.lines) {
        if (!raw.trim()) { body.push({ text: '', tool: false }); continue; }
        const tool = /^\s*[⎿⏺⧉│┃]/.test(raw);
        for (const piece of wrapText(raw, inner)) body.push({ text: piece, tool });
      }
    } else if (msg && msg.error) {
      body = [{ text: msg.error, tool: true }];
    } else {
      body = [{ text: 'reading the agent screen…', tool: true }];
    }

    const maxScroll = Math.max(0, body.length - bodyRows);
    this.readScroll = Math.max(0, Math.min(this.readScroll || 0, maxScroll));
    const view = body.slice(this.readScroll, this.readScroll + bodyRows);

    const stateColor = STATE_COLOR[w.state] || P.grey;
    const titleLeft = `${fg(agentColor(w.name))}${BOLD}${w.name}${RESET} ${fg(stateColor)}${w.state}${RESET} ${fg(P.grey)}${truncate(e.building.label, Math.max(10, cols - 40))}${RESET}`;
    const titlePlain = `${w.name} ${w.state} ${truncate(e.building.label, Math.max(10, cols - 40))}`;
    const right = `${fg(P.dark)}${w.paneId}${RESET}`;
    const gap = Math.max(1, cols - width(titlePlain) - width(w.paneId) - 2);

    const lines = [];
    lines.push(` ${titleLeft}${' '.repeat(gap)}${right}`);
    lines.push(`${fg(P.dark)}${'─'.repeat(cols)}${RESET}`);
    for (const line of view) {
      // Tool output stays visible but recedes, so prose is what you read.
      lines.push(`  ${fg(line.tool ? P.slate : P.white)}${line.text}${RESET}`);
    }
    for (let i = view.length; i < bodyRows; i++) lines.push('');

    // A multiple-choice prompt, answerable in place. Each row shows the key
    // the agent printed, so what will be sent is never a surprise.
    if (choices) {
      lines.push(` ${fg(P.dark)}${'─'.repeat(Math.max(0, cols - 2))}${RESET}`);
      choices.options.forEach((o, i) => {
        const num = i + 1;
        const sends = `${fg(P.dark)}sends ${fg(P.lime)}${o.key}${RESET}`;
        const label = truncate(o.label, Math.max(12, cols - 26));
        lines.push(` ${fg(P.white)}${BOLD}[${num}]${RESET} ${fg(P.white)}${label}${RESET}  ${sends}`);
      });
    }

    {
      const pos = maxScroll > 0
        ? `${fg(P.grey)}line ${this.readScroll + 1}-${Math.min(body.length, this.readScroll + bodyRows)} of ${body.length}${RESET}`
        : `${fg(P.dark)}${body.length} line${body.length === 1 ? '' : 's'}${RESET}`;
      const status = this.status && Date.now() < this.statusUntil
        ? `   ${fg(P.cyan)}${truncate(this.status, Math.max(10, cols - 30))}${RESET}`
        : '';
      const keys = choices
        ? [[`1-${choices.options.length}`, 'answer'], ['r', 'reply'], ['t', 'talk to agent'], ['enter', 'go to agent'], ['esc', 'back']]
        : [['↑↓/wheel', 'scroll'], ['r', 'reply'], ['t', 'talk to agent'], ['enter', 'go to agent'], ['esc', 'back']];
      const keyText = keys
        .map(([k, d]) => `${fg(P.white)}${k}${RESET}${fg(P.slate)} ${d}${RESET}`)
        .join(`${fg(P.dark)}  ${RESET}`);
      lines.push(` ${pos}${status}`);
      lines.push(` ${keyText}`);
    }

    return `\x1b[H${lines.slice(0, rows).join('\x1b[K\r\n')}\x1b[K`;
  }

  header(cols) {
    const t = this.town;
    const n = this.world.towns.length;
    if (this.mode === 'world') {
      const totals = this.world.towns.reduce((acc, x) => {
        acc.working += x.counts.working;
        acc.blocked += x.counts.blocked;
        acc.agents += x.agentCount;
        return acc;
      }, { working: 0, blocked: 0, agents: 0 });
      const left = `${fg(P.cyan)}${BOLD}THE WORLD${RESET}  ${fg(P.grey)}${n} town${n === 1 ? '' : 's'} · ${totals.agents} agents${RESET}`;
      const right = `${fg(P.lime)}${totals.working} working${RESET} ${fg(P.grey)}·${RESET} ${fg(totals.blocked ? P.red : P.slate)}${totals.blocked} blocked${RESET}`;
      return this.bar(left, right, cols, `THE WORLD  ${n} towns · ${totals.agents} agents`, `${totals.working} working · ${totals.blocked} blocked`);
    }

    if (!t) return pad(`${fg(P.grey)} no workspaces${RESET}`, cols);
    const c = t.counts;
    const phase = this.sky ? this.sky.label : '';
    const counts = `${t.agentCount} agent${t.agentCount === 1 ? '' : 's'} · ${t.buildingList.length} building${t.buildingList.length === 1 ? '' : 's'}${phase ? ` · ${phase}` : ''}`;
    const leftPlain = `TOWN OF ${t.label.toUpperCase()}  ${counts}`;
    const left = `${fg(P.yellow)}${BOLD}TOWN OF ${t.label.toUpperCase()}${RESET}  ${fg(P.grey)}${counts}${RESET}`;
    const rightPlain = `${c.working}▲ ${c.blocked}! ${c.idle}z   [${this.townIndex + 1}/${n}]`;
    const right = `${fg(P.lime)}${c.working}▲${RESET} ${fg(c.blocked ? P.red : P.slate)}${c.blocked}!${RESET} ${fg(P.slate)}${c.idle}z${RESET}   ${fg(P.grey)}[${this.townIndex + 1}/${n}]${RESET}`;
    return this.bar(left, right, cols, leftPlain, rightPlain);
  }

  bar(left, right, cols, leftPlain, rightPlain) {
    const gap = cols - width(leftPlain) - width(rightPlain) - 2;
    if (gap < 1) return ` ${truncate(leftPlain, cols - 2)} `;
    return ` ${left}${' '.repeat(gap)}${right} `;
  }

  townLabels(lots, cols, sel) {
    let row = ' '.repeat(cols);
    const put = (x, text) => {
      const chars = [...row];
      const t = [...text];
      for (let i = 0; i < t.length && x + i < cols; i++) chars[x + i] = t[i];
      row = chars.join('');
    };
    for (const lot of lots) {
      put(lot.x, center(truncate(lot.building.label, lot.w - 2), lot.w));
    }
    // Colour the whole row, brightening the selected lot's slice.
    const selLot = sel ? lots.find((l) => l.index === sel.buildingIndex) : null;
    if (!selLot) return fg(P.grey) + row + RESET;
    const a = row.slice(0, selLot.x);
    const b = row.slice(selLot.x, selLot.x + selLot.w);
    const c = row.slice(selLot.x + selLot.w);
    const accent = STATE_COLOR[selLot.building.state] || P.white;
    return fg(P.slate) + a + RESET + fg(accent) + BOLD + b + RESET + fg(P.slate) + c + RESET;
  }

  worldLabels(slots, cols) {
    let row = '';
    for (const s of slots) {
      const sel = s.index === this.townIndex;
      const label = truncate(s.town.label, s.w - 2);
      const text = center(label, s.w);
      const color = s.town.counts.blocked ? P.red : s.town.counts.working ? P.lime : P.slate;
      row += (sel ? fg(color) + BOLD : fg(mix(color, P.black, 0.35))) + text + RESET;
    }
    return row;
  }

  footer(cols) {
    const now = Date.now();
    let line1;

    if (this.error) {
      line1 = ` ${fg(P.red)}herdr: ${truncate(this.error, cols - 10)}${RESET}`;
    } else if (this.status && now < this.statusUntil) {
      line1 = ` ${fg(P.cyan)}${truncate(this.status, cols - 2)}${RESET}`;
    } else if (this.unseenSummary().events.length || this.unseenSummary().truncated) {
      line1 = ` ${fg(P.cyan)}${truncate(`s summary · ${this.unseenSummary().events.length} retained updates since last marked read`, cols - 2)}${RESET}`;
    } else if (this.mode === 'world') {
      const t = this.world.towns[this.townIndex];
      if (!t) line1 = ` ${fg(P.grey)}no towns yet${RESET}`;
      else {
        const parts = [
          `${fg(P.white)}${truncate(t.label, 28)}${RESET}`,
          `${fg(P.grey)}${t.agentCount} agents in ${t.buildingList.length} buildings${RESET}`,
        ];
        if (t.counts.blocked) parts.push(`${fg(P.red)}${t.counts.blocked} blocked${RESET}`);
        else if (t.counts.working) parts.push(`${fg(P.lime)}${t.counts.working} working${RESET}`);
        line1 = ' ' + parts.join(`${fg(P.dark)} · ${RESET}`);
      }
    } else {
      const e = this.selectedEntry();
      if (!e) {
        line1 = ` ${fg(P.grey)}This town is quiet — no agents running here yet.${RESET}`;
      } else {
        const w = e.worker;
        const b = e.building;
        const stateColor = STATE_COLOR[w.state] || P.grey;
        const mins = this.store.workMs(b.key);
        // The label row under the building already names the feature, so this
        // line spends its width on what the agent actually said instead.
        const msg = this.messages.get(w.paneId);
        let teaser;
        let teaserColor = P.white;
        if (msg && msg.summary) teaser = `"${msg.summary}"`;
        else if (msg && msg.error) { teaser = msg.error; teaserColor = P.slate; }
        else { teaser = 'reading screen…'; teaserColor = P.slate; }

        const meta = `${w.name} · ${w.state} · ${b.floors}/${MAX_FLOORS}f · ${humanDuration(mins)}`;
        const room = Math.max(12, cols - width(meta) - 8);
        const parts = [
          `${fg(agentColor(w.name))}${BOLD}${w.name}${RESET}`,
          `${fg(stateColor)}${w.state}${RESET}`,
          `${fg(teaserColor)}${truncate(teaser, room)}${RESET}`,
          `${fg(P.dark)}${b.floors}/${MAX_FLOORS}f · ${humanDuration(mins)}${RESET}`,
        ];
        line1 = ' ' + parts.join(`${fg(P.dark)} · ${RESET}`);
      }
    }

    const keys = this.mode === 'world'
      ? [['s', 'summary'], ['a', 'attention'], ['b', 'buildings'], ['/', 'search'], ['←→', 'town'], ['enter', 'visit'], ['w', 'town'], ['q', 'quit']]
      : [['s', 'summary'], ['a', 'attention'], ['b', 'buildings'], ['/', 'search'], ['←→', 'agent'], ['↑↓', 'town'], ['enter', 'read'], ['w', 'world'], ['q', 'quit']];
    const line2 = ' ' + keys
      .map(([k, d]) => `${fg(P.white)}${k}${RESET}${fg(P.slate)} ${d}${RESET}`)
      .join(`${fg(P.dark)}  ${RESET}`);

    const plainKeys = ' ' + keys.map(([k, d]) => `${k} ${d}`).join('  ');
    return [line1, width(plainKeys) > cols ? fg(P.grey) + truncate(plainKeys, cols) + RESET : line2];
  }

  // --------------------------------------------------------------- input

  // Terminal cells are 1-indexed and one canvas column is one terminal column,
  // but a cell spans two pixel rows, so a click resolves to a 2px band.
  hitWorker(col, row) {
    const px = col - 1;
    const cellRow = row - 1 - HEADER_ROWS;
    if (cellRow < 0) return null;
    const py = cellRow * 2;
    return this.hitRects.find((r) => px >= r.x && px < r.x + r.w
      && py >= r.y - 2 && py < r.y + r.h + 1) || null;
  }

  onMouse(ev) {
    if (!this.mouseEnabled) return;
    if (this.replyMode) {
      if (ev.press) {
        if (ev.name === 'wheel-up') this.scrollReply(-3);
        else if (ev.name === 'wheel-down') this.scrollReply(3);
      }
      return;
    }
    if (this.mode === 'summary') {
      if (ev.press && ev.name === 'wheel-up') this.summaryScroll = Math.max(0, this.summaryScroll - 3);
      else if (ev.press && ev.name === 'wheel-down') this.summaryScroll += 3;
      return;
    }

    if (this.mode === 'browse' || this.mode === 'inspect') {
      const delta = ev.name === 'wheel-up' ? -1 : ev.name === 'wheel-down' ? 1 : 0;
      if (delta && ev.press) {
        if (this.mode === 'browse') this.moveBrowser(delta);
        else this.inspectScroll = Math.max(0, this.inspectScroll + delta * 3);
      }
      return;
    }
    if (this.mode === 'read') {
      if (ev.name === 'wheel-up' && ev.press) this.readScroll -= 3;
      else if (ev.name === 'wheel-down' && ev.press) this.readScroll += 3;
      return;
    }
    if (this.mode === 'relay') {
      if (this.relayCompose) return;
      const last = this.relayRecipients().length - 1;
      if (ev.name === 'wheel-up' && ev.press) this.relayRecipientIndex = Math.max(0, this.relayRecipientIndex - 1);
      else if (ev.name === 'wheel-down' && ev.press) this.relayRecipientIndex = Math.min(last, this.relayRecipientIndex + 1);
      return;
    }
    if (this.mode === 'world') return;

    // Wheel walks the workers, which is the same thing the arrow keys do.
    if (ev.name === 'wheel-up' && ev.press) { this.moveSelection(-1); return; }
    if (ev.name === 'wheel-down' && ev.press) { this.moveSelection(1); return; }

    const hit = this.hitWorker(ev.col, ev.row);

    // Hover selects. This is the whole point of mouse support: sweep the
    // pointer across the town and each worker's bubble reveals as you pass.
    if (ev.name === 'motion') {
      if (hit && hit.paneId !== this.selectedPaneId) this.selectedPaneId = hit.paneId;
      return;
    }

    if (ev.name === 'left' && ev.press) {
      if (!hit) return;
      // Click the worker you are already on to read it; otherwise select.
      if (hit.paneId === this.selectedPaneId) this.openRead();
      else this.selectedPaneId = hit.paneId;
    }
  }

  onKey(seq) {
    const s = seq.toString();

    const right = s === '\x1b[C' || s === '\x1bOC' || s === 'l';
    const left = s === '\x1b[D' || s === '\x1bOD' || s === 'h';
    const up = s === '\x1b[A' || s === '\x1bOA' || s === 'k';
    const down = s === '\x1b[B' || s === '\x1bOB' || s === 'j';

    if (this.replyMode) { this.replyKey(s); return; }
    if (this.mode === 'summary') {
      if (s === '\x1b') this.mode = this.summaryReturnMode;
      else if (s === 'q' || s === '\x03') this.running = false;
      else if (up) this.summaryScroll = Math.max(0, this.summaryScroll - 1);
      else if (down) this.summaryScroll++;
      else if (s === '\x1b[5~') this.summaryScroll = Math.max(0, this.summaryScroll - 10);
      else if (s === '\x1b[6~' || s === ' ') this.summaryScroll += 10;
      else if (s === 'r') this.openSummary();
      else if (s === 'c') this.acknowledgeSummary();
      return;
    }
    if (this.mode === 'browse') {
      this.browserKey(s);
      return;
    }
    if (this.mode === 'inspect') {
      if (s === '\x1b') this.mode = 'browse';
      else if (s === 'q' || s === '\x03') this.running = false;
      else if (up) this.inspectScroll = Math.max(0, this.inspectScroll - 1);
      else if (down) this.inspectScroll++;
      else if (s === '\x1b[5~') this.inspectScroll = Math.max(0, this.inspectScroll - 10);
      else if (s === '\x1b[6~' || s === ' ') this.inspectScroll += 10;
      return;
    }

    // While composing a relay, every printable key belongs to its composer.
    if (this.relayCompose) {
      if (s === '\x1b' || s === '\x03') { this.relayCompose = false; this.relayText = ''; return; }
      if (s === '\r' || s === '\n') { this.sendRelay(); return; }
      if (s === '\x7f' || s === '\b') { this.relayText = [...this.relayText].slice(0, -1).join(''); return; }
      if (s === '\x15') { this.relayText = ''; return; }
      if (!s.startsWith('\x1b')) {
        const printable = [...s].filter((ch) => ch.codePointAt(0) >= 0x20 && ch.codePointAt(0) !== 0x7f).join('');
        if (printable) this.relayText += printable;
      }
      return;
    }

    // Reading view has its own bindings; escape backs out to the town rather
    // than quitting, so drilling in is never a one-way door.
    if (this.mode === 'read') {
      if (s === '\x1b') { this.mode = this.readReturnMode; return; }
      if (s === 'q' || s === '\x03') { this.running = false; return; }
      if (up) this.readScroll -= 1;
      else if (down) this.readScroll += 1;
      else if (s === '\x1b[5~') this.readScroll -= 10;
      else if (s === '\x1b[6~' || s === ' ') this.readScroll += 10;
      else if (this.choices && /^[1-9]$/.test(s)) {
        this.answerChoice(Number(s) - 1);
      } else if (s === 'r') this.openReply();
      else if (s === 't') this.openRelay();
      else if (left) this.mode = this.readReturnMode;
      else if (s === '\r' || s === '\n') {
        const e = this.allWorkers().find((x) => x.paneId === this.readPaneId);
        if (e) this.pendingFocus = e.worker;
      }
      return;
    }

    if (this.mode === 'relay') {
      const recipients = this.relayRecipients();
      if (s === '\x1b' || s === '\x03' || s === 'q' || left) { this.mode = 'read'; return; }
      if (up) this.relayRecipientIndex = Math.max(0, this.relayRecipientIndex - 1);
      else if (down) this.relayRecipientIndex = Math.min(recipients.length - 1, this.relayRecipientIndex + 1);
      else if (s === '\r' || s === '\n') {
        const target = recipients[this.relayRecipientIndex];
        if (target) {
          this.relayRecipientPaneId = target.paneId;
          this.relayCompose = true;
          this.relayText = '';
        }
      }
      return;
    }

    if (s === 'q' || s === '\x03' || s === '\x1b') {
      this.running = false;
      return;
    }
    if (s === 's') { this.openSummary(); return; }
    if (s === 'a' || s === 'b' || s === '/') {
      this.openBrowser(s === 'a' ? 'attention' : s === 'b' ? 'buildings' : 'search');
      return;
    }
    if (s === 'w' || s === '\t') {
      this.mode = this.mode === 'world' ? 'town' : 'world';
      return;
    }
    if (s === 'r') {
      this.lastPoll = 0;
      this.setStatus('refreshing…', 800);
      return;
    }
    if (s === 'm') {
      // Release the mouse so Herdr's own click-to-focus works again.
      this.mouseEnabled = !this.mouseEnabled;
      process.stdout.write(this.mouseEnabled ? mouse.ENABLE : mouse.DISABLE);
      this.setStatus(this.mouseEnabled ? 'mouse on' : 'mouse off — Herdr has it back');
      return;
    }

    if (this.mode === 'world') {
      if (right) this.changeTown(1);
      else if (left) this.changeTown(-1);
      else if (s === '\r' || s === '\n') this.mode = 'town';
      return;
    }

    if (right) this.moveSelection(1);
    else if (left) this.moveSelection(-1);
    else if (down) this.changeTown(1);
    else if (up) this.changeTown(-1);
    else if (s === '\r' || s === '\n') this.openRead();
  }
}

// ------------------------------------------------------------------ boot

async function main() {
  const out = process.stdout;

  if (!out.isTTY && !ONCE) {
    process.stderr.write(
      'herdr-town needs a terminal.\n'
      + 'Open it inside Herdr:\n'
      + '  herdr plugin pane open --plugin efeguclu.town --entrypoint town\n',
    );
    process.exit(1);
  }

  // Keep progress accruing even if Herdr started before this plugin existed.
  if (!ONCE) ensureRecorder();

  const app = new App({ summaryCursor: new SummaryCursor() });
  await app.poll();
  if (!ONCE) app.offerSummary();

  const cols = () => Math.max(MIN_COLS, out.columns || 100);
  const rows = () => Math.max(MIN_ROWS, out.rows || 30);

  if (ONCE) {
    if (READ_ARG) {
      // Jump to whichever town owns that pane, then wait for its message.
      const owner = app.world.towns.find((t) => t.buildingList
        .some((b) => b.workers.some((w) => w.paneId === READ_ARG)));
      if (owner) app.townIndex = app.world.towns.indexOf(owner);
      app.selectedPaneId = READ_ARG;
      app.readPaneId = READ_ARG;
      app.mode = 'read';
      await app.messages.ensure(READ_ARG);
    } else {
      // Warm the visible town's messages so a one-shot render shows bubbles.
      const list = app.selectionList().slice(0, 4);
      await Promise.all(list.map((e) => app.messages.ensure(e.paneId)));
    }
    const frame = app.render(cols(), rows());
    if (argv.includes('--dump-hits')) {
      process.stderr.write(`canvas ${cols()}x${(rows() - CHROME_ROWS) * 2}px\n`);
      for (const r of app.hitRects) {
        const topRow = Math.floor(r.y / 2) + 1 + HEADER_ROWS;
        const botRow = Math.floor((r.y + r.h) / 2) + 1 + HEADER_ROWS;
        process.stderr.write(`  ${r.paneId}  px x=${r.x}-${r.x + r.w} y=${r.y}-${r.y + r.h}  -> cols ${r.x + 1}-${r.x + r.w} rows ${topRow}-${botRow}\n`);
      }
      return;
    }
    out.write(frame + '\n');
    return;
  }

  out.write('\x1b[?1049h\x1b[?25l\x1b[2J');
  out.write(mouse.ENABLE + INPUT_ENABLE);

  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    out.write(mouse.DISABLE + INPUT_DISABLE);
    out.write('\x1b[0m\x1b[?25h\x1b[?1049l');
    if (process.stdin.isTTY) {
      try { process.stdin.setRawMode(false); } catch { /* already gone */ }
    }
    process.stdin.pause();
  };

  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true);
    process.stdin.resume();
    const input = new TerminalInput((event) => {
      if (event.type === 'paste') app.onPaste(event.text, event.truncated);
      else if (event.type === 'mouse') app.onMouse(event.event);
      else if (event.type === 'focus') app.onFocus(event.focused);
      else app.onKey(event.text);
    });
    let escapeTimer;
    process.stdin.on('data', (data) => {
      clearTimeout(escapeTimer);
      input.feed(data);
      escapeTimer = setTimeout(() => input.flushEscape(), 40);
      escapeTimer.unref();
    });
  }

  const tick = async () => {
    if (!app.running) return finish();

    const now = Date.now();
    if (now - app.lastPoll >= POLL_MS) {
      app.lastPoll = now;
      app.poll(); // fire and forget; the loop keeps animating while it lands
    }

    if (app.pendingFocus) {
      const target = app.pendingFocus;
      app.pendingFocus = null;
      try {
        await focusAgent(target.paneId);
        // Keep the town running. Jumping to an agent is navigation, not an
        // exit — you come straight back to the same view.
        //
        // Drop back to the map first. Once you have gone to the agent, the
        // message you were reading is spent: leaving the reading view up means
        // switching back to this tab shows a stale transcript and needs an
        // extra escape before you can see the town again.
        app.mode = 'town';
        app.readScroll = 0;
        app.setStatus(`→ jumped to ${target.name} · ${target.paneId} · town still open here`);
      } catch (e) {
        app.setStatus(`could not focus ${target.paneId}: ${e.message}`);
      }
    }

    app.frame++;
    try {
      out.write(app.render(cols(), rows()));
    } catch { /* terminal went away mid-write */ }
  };

  const timer = setInterval(tick, FRAME_MS);

  const finish = () => {
    clearInterval(timer);
    cleanup();
    process.exit(0);
  };

  out.on('resize', () => out.write('\x1b[2J'));
  process.on('SIGINT', finish);
  process.on('SIGTERM', finish);
  process.on('SIGHUP', finish);
  process.on('exit', cleanup);
}

module.exports = { App, width, replyLayout };

if (require.main === module) main().catch((e) => {
  process.stdout.write(INPUT_DISABLE + '\x1b[0m\x1b[?25h\x1b[?1049l');
  process.stderr.write(`herdr-town: ${e && e.stack ? e.stack : e}\n`);
  process.exit(1);
});
