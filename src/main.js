'use strict';

const { Canvas } = require('./canvas');
const { P, agentColor, mix } = require('./palette');
const { drawTown, drawWorld, STATE_COLOR } = require('./scene');
const { snapshot, focusAgent, promptAgent } = require('./herdr');
const { Store } = require('./store');
const { buildWorld, addGhosts, FLOOR_MINUTES, MAX_FLOORS } = require('./world');
const { ensureRecorder } = require('./ensure-recorder');
const { MessageCache } = require('./message');
const mouse = require('./mouse');
const daylight = require('./daylight');

const { StringDecoder } = require('node:string_decoder');

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

// ------------------------------------------------------------------ app

class App {
  constructor() {
    this.store = new Store({ readOnly: true });
    // What each agent last said. Fetched behind the render loop, never in it.
    this.messages = new MessageCache();
    this.world = { towns: [], at: 0 };
    this.frame = 0;
    this.mode = 'town'; // 'town' | 'world'
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
    // Worker rectangles from the last rendered frame, in canvas pixels.
    this.hitRects = [];
    this.mouseEnabled = true;
    // Reply composer, only reachable from the reading view.
    this.replyMode = false;
    this.replyText = '';
    this.replySending = false;
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
    try {
      const snap = await snapshot();
      // The background recorder owns build progress; the view just reads
      // whatever it has written, then raises the standing skyline of features
      // whose agents have since gone.
      this.store.syncFromDisk();
      this.world = addGhosts(buildWorld(snap, this.store), this.store);
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
    }
  }

  // ---------------------------------------------------------------- draw

  // Open the full message for the selected worker. The town keeps running
  // underneath; this is a mode, not a new process.
  openRead() {
    const e = this.selectedEntry();
    if (!e) return;
    this.mode = 'read';
    this.readPaneId = e.paneId;
    this.readScroll = 0;
  }

  // Send the composed reply to the agent. Errors surface in the status line
  // rather than throwing, so a failed send never takes the town down.
  async sendReply() {
    const text = this.replyText.trim();
    const paneId = this.readPaneId;
    if (!text || !paneId || this.replySending) return;
    this.replySending = true;
    try {
      await promptAgent(paneId, text);
      this.replyText = '';
      this.replyMode = false;
      this.setStatus(`sent to ${paneId}`, 3000);
      // The agent's screen is about to change, so drop the cached read.
      this.messages.entries.delete(paneId);
    } catch (e) {
      // execFile's generic "Command failed: <argv>" is noise in a status bar.
      const raw = (e.message || '').split('\n')[0];
      const clean = /^Command failed/.test(raw)
        ? 'agent did not accept the prompt'
        : raw;
      this.setStatus(`could not send: ${clean}`, 5000);
    } finally {
      this.replySending = false;
    }
  }

  render(cols, rows) {
    if (this.mode === 'read') return this.renderRead(cols, rows);

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

  // The reading view. Deliberately real terminal text rather than the 3x5
  // pixel font: bubbles are for three words, paragraphs need actual glyphs.
  renderRead(cols, rows) {
    const e = this.selectionList().find((x) => x.paneId === this.readPaneId)
      || this.selectedEntry();
    if (!e) { this.mode = 'town'; return this.render(cols, rows); }

    const w = e.worker;
    const msg = this.messages.get(w.paneId);
    const inner = Math.max(20, cols - 4);
    const bodyRows = Math.max(3, rows - 4);

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

    if (this.replyMode) {
      // Composer takes both footer rows: the prompt, and what it will do.
      const label = `reply to ${w.name} › `;
      const room = Math.max(10, cols - width(label) - 3);
      // Show the tail once the line outgrows the row, like a real input.
      const shown = width(this.replyText) > room
        ? `…${[...this.replyText].slice(-(room - 1)).join('')}`
        : this.replyText;
      const cursor = this.replySending ? '' : `${fg(P.lime)}▌${RESET}`;
      lines.push(` ${fg(P.lime)}${label}${RESET}${fg(P.white)}${shown}${RESET}${cursor}`);
      lines.push(this.replySending
        ? ` ${fg(P.cyan)}sending…${RESET}`
        : ` ${fg(P.white)}enter${RESET}${fg(P.slate)} send${RESET}${fg(P.dark)}  ${RESET}`
          + `${fg(P.white)}esc${RESET}${fg(P.slate)} cancel${RESET}${fg(P.dark)}  ${RESET}`
          + `${fg(P.white)}ctrl+u${RESET}${fg(P.slate)} clear${RESET}`);
    } else {
      const pos = maxScroll > 0
        ? `${fg(P.grey)}line ${this.readScroll + 1}-${Math.min(body.length, this.readScroll + bodyRows)} of ${body.length}${RESET}`
        : `${fg(P.dark)}${body.length} line${body.length === 1 ? '' : 's'}${RESET}`;
      const status = this.status && Date.now() < this.statusUntil
        ? `   ${fg(P.cyan)}${truncate(this.status, Math.max(10, cols - 30))}${RESET}`
        : '';
      const keys = [['↑↓/wheel', 'scroll'], ['r', 'reply'], ['enter', 'go to this agent'], ['esc', 'back'], ['q', 'quit']];
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
      ? [['←→', 'town'], ['enter', 'visit'], ['w', 'town view'], ['q', 'quit']]
      : [['←→/hover', 'agent'], ['↑↓', 'town'], ['enter/click', 'read'], ['w', 'world'], ['q', 'quit']];
    const line2 = ' ' + keys
      .map(([k, d]) => `${fg(P.white)}${k}${RESET}${fg(P.slate)} ${d}${RESET}`)
      .join(`${fg(P.dark)}  ${RESET}`);

    return [line1, line2];
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

    if (this.mode === 'read') {
      if (ev.name === 'wheel-up' && ev.press) this.readScroll -= 3;
      else if (ev.name === 'wheel-down' && ev.press) this.readScroll += 3;
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

    // While composing, every key belongs to the composer. Nothing here may
    // fall through to a town binding, or typing "q" would quit mid-sentence.
    if (this.replyMode) {
      if (s === '\x1b' || s === '\x03') {
        this.replyMode = false;
        this.replyText = '';
        return;
      }
      if (s === '\r' || s === '\n') { this.sendReply(); return; }
      if (s === '\x7f' || s === '\b') {
        this.replyText = [...this.replyText].slice(0, -1).join('');
        return;
      }
      if (s === '\x15') { this.replyText = ''; return; } // ctrl+u
      // Printable text only. Drops stray escape sequences (arrows, mouse
      // leftovers) instead of pasting their bytes into the prompt.
      if (!s.startsWith('\x1b')) {
        const printable = [...s].filter((ch) => {
          const cp = ch.codePointAt(0);
          return cp >= 0x20 && cp !== 0x7f;
        }).join('');
        if (printable) this.replyText += printable;
      }
      return;
    }

    // Reading view has its own bindings; escape backs out to the town rather
    // than quitting, so drilling in is never a one-way door.
    if (this.mode === 'read') {
      if (s === '\x1b') { this.mode = 'town'; return; }
      if (s === 'q' || s === '\x03') { this.running = false; return; }
      if (up) this.readScroll -= 1;
      else if (down) this.readScroll += 1;
      else if (s === '\x1b[5~') this.readScroll -= 10;
      else if (s === '\x1b[6~' || s === ' ') this.readScroll += 10;
      else if (s === 'r') { this.replyMode = true; this.replyText = ''; }
      else if (left) this.mode = 'town';
      else if (s === '\r' || s === '\n') {
        const e = this.selectionList().find((x) => x.paneId === this.readPaneId);
        if (e) this.pendingFocus = e.worker;
      }
      return;
    }

    if (s === 'q' || s === '\x03' || s === '\x1b') {
      this.running = false;
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

  const app = new App();
  await app.poll();

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
  out.write(mouse.ENABLE);

  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    out.write(mouse.DISABLE);
    out.write('\x1b[0m\x1b[?25h\x1b[?1049l');
    if (process.stdin.isTTY) {
      try { process.stdin.setRawMode(false); } catch { /* already gone */ }
    }
    process.stdin.pause();
  };

  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true);
    process.stdin.resume();
    // Decode after splitting off mouse reports, so a multi-byte character
    // arriving in two chunks (common when typing Turkish) is reassembled
    // rather than pasted into the reply as mojibake.
    const decoder = new StringDecoder('utf8');
    process.stdin.on('data', (d) => {
      // Mouse reports arrive on stdin alongside keys; split them out first.
      const { events, rest } = mouse.parse(d);
      for (const ev of events) app.onMouse(ev);
      if (rest.length) {
        const text = decoder.write(rest);
        if (text) app.onKey(text);
      }
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

main().catch((e) => {
  process.stdout.write('\x1b[0m\x1b[?25h\x1b[?1049l');
  process.stderr.write(`herdr-town: ${e && e.stack ? e.stack : e}\n`);
  process.exit(1);
});
