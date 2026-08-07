'use strict';

// Does a Herdr pane forward mouse events to the process running inside it?
//
// Terminals only send mouse reports when an application asks for them. This
// asks, then shows every byte that arrives on stdin. If Herdr forwards clicks,
// they show up here as SGR sequences. If Herdr consumes them for its own UI
// (pane focus, split dragging, drag-select), nothing arrives and the town has
// to stay keyboard-driven.
//
// Run it inside a Herdr pane, click around, press q. The verdict is written to
// RESULT_FILE so it can be read back without copying anything.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const RESULT_FILE = path.join(os.tmpdir(), 'herdr-town-mouse-probe.json');

// Mouse tracking modes, enabled together. Each answers a slightly different
// question, and Herdr could plausibly forward one but not another.
const MODES = [
  { code: '1000', label: 'click tracking (press/release)' },
  { code: '1002', label: 'button-event tracking (drag)' },
  { code: '1003', label: 'any-event tracking (motion)' },
  { code: '1006', label: 'SGR extended coordinates' },
];

const ENABLE = MODES.map((m) => `\x1b[?${m.code}h`).join('');
const DISABLE = MODES.slice().reverse().map((m) => `\x1b[?${m.code}l`).join('');

const out = process.stdout;
const events = [];
const rawChunks = [];
let marks = [];
const trail = [];
let started = Date.now();

function decodeSGR(seq) {
  // \x1b[<btn;col;rowM  (press)  or  ...m  (release)
  const m = /^\x1b\[<(\d+);(\d+);(\d+)([Mm])$/.exec(seq);
  if (!m) return null;
  const btn = Number(m[1]);
  const col = Number(m[2]);
  const row = Number(m[3]);
  const press = m[4] === 'M';

  const motion = (btn & 32) !== 0;
  const wheel = (btn & 64) !== 0;
  const base = btn & 3;
  let name;
  if (wheel) name = base === 0 ? 'wheel-up' : 'wheel-down';
  else if (motion) name = 'motion';
  else name = ['left', 'middle', 'right', 'release'][base];

  const mods = [];
  if (btn & 4) mods.push('shift');
  if (btn & 8) mods.push('meta');
  if (btn & 16) mods.push('ctrl');

  return { kind: 'sgr', name, press, col, row, mods, btn, raw: seq };
}

function decodeX10(buf) {
  // Legacy: \x1b[M then three bytes, each offset by 32.
  if (buf.length < 6) return null;
  if (buf[0] !== 0x1b || buf[1] !== 0x5b || buf[2] !== 0x4d) return null;
  const btn = buf[3] - 32;
  const col = buf[4] - 32;
  const row = buf[5] - 32;
  const base = btn & 3;
  return {
    kind: 'x10',
    name: ['left', 'middle', 'right', 'release'][base],
    press: base !== 3,
    col,
    row,
    mods: [],
    btn,
    raw: `\\x1b[M ${btn} ${col} ${row}`,
  };
}

// Pull every complete mouse sequence out of a chunk; return leftovers as text.
function parseChunk(buf) {
  const found = [];
  const other = [];
  let i = 0;
  while (i < buf.length) {
    if (buf[i] === 0x1b && buf[i + 1] === 0x5b && buf[i + 2] === 0x3c) {
      // SGR: read until M or m
      let j = i + 3;
      while (j < buf.length && buf[j] !== 0x4d && buf[j] !== 0x6d) j++;
      if (j < buf.length) {
        const ev = decodeSGR(buf.slice(i, j + 1).toString('latin1'));
        if (ev) found.push(ev);
        i = j + 1;
        continue;
      }
    }
    if (buf[i] === 0x1b && buf[i + 1] === 0x5b && buf[i + 2] === 0x4d) {
      const ev = decodeX10(buf.slice(i, i + 6));
      if (ev) {
        found.push(ev);
        i += 6;
        continue;
      }
    }
    other.push(buf[i]);
    i++;
  }
  return { found, other: Buffer.from(other) };
}

function hex(buf) {
  return [...buf].map((b) => b.toString(16).padStart(2, '0')).join(' ');
}

const C = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  green: '\x1b[38;5;114m',
  red: '\x1b[38;5;203m',
  yellow: '\x1b[38;5;221m',
  cyan: '\x1b[38;5;80m',
  grey: '\x1b[38;5;245m',
};

function render() {
  const cols = out.columns || 80;
  const rows = out.rows || 24;
  const lines = [];

  const got = events.length > 0;
  const verdict = got
    ? `${C.green}${C.bold}MOUSE EVENTS: RECEIVED (${events.length})${C.reset}  ${C.green}Herdr FORWARDS clicks${C.reset}`
    : `${C.yellow}${C.bold}MOUSE EVENTS: NONE YET${C.reset}  ${C.grey}click anywhere in this pane${C.reset}`;

  lines.push(` ${C.bold}${C.cyan}herdr-town mouse probe${C.reset}  ${C.grey}pane ${process.env.HERDR_PANE_ID || '(not in a herdr pane?)'}${C.reset}`);
  lines.push(` ${verdict}`);
  lines.push(` ${C.grey}${'─'.repeat(Math.max(0, cols - 2))}${C.reset}`);

  // Click canvas. The canvas starts at lines index 3, which is terminal row 4,
  // so a click at row R lands on grid row R-4. Getting this wrong puts every
  // marker one row off and silently swallows clicks in the top row.
  const CANVAS_FIRST_ROW = 4; // 1-indexed terminal row
  const canvasH = Math.max(4, rows - 12);
  const grid = [];
  for (let r = 0; r < canvasH; r++) grid.push(new Array(cols).fill(' '));

  // Hover trail: motion is forwarded, so show where the pointer has been.
  for (const t of trail.slice(-25)) {
    const gr = t.row - CANVAS_FIRST_ROW;
    const gc = t.col - 1;
    if (gr >= 0 && gr < canvasH && gc >= 0 && gc < cols && grid[gr][gc] === ' ') {
      grid[gr][gc] = '·';
    }
  }
  for (const mk of marks.slice(-60)) {
    const gr = mk.row - CANVAS_FIRST_ROW;
    const gc = mk.col - 1;
    if (gr >= 0 && gr < canvasH && gc >= 0 && gc < cols) grid[gr][gc] = mk.ch;
  }
  for (let r = 0; r < canvasH; r++) {
    lines.push(`${C.green}${grid[r].join('')}${C.reset}`);
  }

  lines.push(` ${C.grey}${'─'.repeat(Math.max(0, cols - 2))}${C.reset}`);

  // Last few decoded events.
  const recent = events.slice(-3);
  if (recent.length === 0) {
    lines.push(` ${C.dim}no mouse bytes yet. if nothing appears after clicking,${C.reset}`);
    lines.push(` ${C.dim}Herdr is consuming mouse input for its own UI.${C.reset}`);
  } else {
    for (const e of recent) {
      const mods = e.mods.length ? `+${e.mods.join('+')}` : '';
      lines.push(` ${C.cyan}${e.kind}${C.reset} ${C.bold}${e.name}${mods}${C.reset} ${e.press ? 'press' : 'release'} ${C.grey}col ${e.col} row ${e.row}${C.reset}`);
    }
    while (lines.length < rows - 2) lines.push('');
  }

  const help = ` ${C.bold}click${C.reset}${C.grey} anywhere${C.reset}   ${C.bold}ctrl+click${C.reset}${C.grey} test modifier${C.reset}   ${C.bold}scroll${C.reset}${C.grey} test wheel${C.reset}   ${C.bold}q${C.reset}${C.grey} finish${C.reset}`;
  const frame = lines.slice(0, rows - 1).join('\x1b[K\r\n');
  out.write(`\x1b[H${frame}\x1b[K\r\n${help}\x1b[K`);
}

function finish() {
  const verdict = events.length > 0 ? 'FORWARDED' : 'NOT_FORWARDED';
  const byKind = {};
  for (const e of events) byKind[e.name] = (byKind[e.name] || 0) + 1;

  const result = {
    verdict,
    event_count: events.length,
    events_by_type: byKind,
    modifiers_seen: [...new Set(events.flatMap((e) => e.mods))],
    sgr_seen: events.some((e) => e.kind === 'sgr'),
    x10_seen: events.some((e) => e.kind === 'x10'),
    in_herdr_pane: !!process.env.HERDR_PANE_ID,
    pane_id: process.env.HERDR_PANE_ID || null,
    herdr_env: process.env.HERDR_ENV || null,
    term: process.env.TERM || null,
    duration_s: Math.round((Date.now() - started) / 1000),
    non_mouse_bytes_sample: rawChunks.slice(0, 8),
    sample_events: events.slice(0, 12),
    at: new Date().toISOString(),
  };

  try {
    fs.writeFileSync(RESULT_FILE, JSON.stringify(result, null, 2), 'utf8');
  } catch { /* best effort */ }

  out.write(DISABLE);
  out.write('\x1b[0m\x1b[?25h\x1b[?1049l');
  if (process.stdin.isTTY) {
    try { process.stdin.setRawMode(false); } catch { /* gone */ }
  }
  process.stdin.pause();

  const banner = verdict === 'FORWARDED'
    ? `${C.green}${C.bold}Herdr FORWARDS mouse events to plugin panes.${C.reset}\nClicking workers in the town is possible.`
    : `${C.yellow}${C.bold}No mouse events reached this process.${C.reset}\nHerdr consumes them for its own UI. The town stays keyboard-driven.`;

  process.stdout.write(`\n${banner}\n\n${C.grey}Captured ${events.length} events in ${result.duration_s}s.\nVerdict written to ${RESULT_FILE}${C.reset}\n`);
  process.exit(0);
}

function main() {
  if (!out.isTTY) {
    process.stderr.write('mouse-probe needs a terminal. Run it inside a Herdr pane.\n');
    process.exit(1);
  }
  if (!process.env.HERDR_PANE_ID) {
    process.stderr.write(
      `${C.yellow}Warning:${C.reset} HERDR_PANE_ID is not set, so this may not be a Herdr pane.\n`
      + 'Results only mean something when run inside Herdr. Continuing anyway.\n\n',
    );
  }

  started = Date.now();
  out.write('\x1b[?1049h\x1b[?25l\x1b[2J');
  out.write(ENABLE);

  process.stdin.setRawMode(true);
  process.stdin.resume();

  process.stdin.on('data', (buf) => {
    const { found, other } = parseChunk(buf);

    for (const ev of found) {
      events.push(ev);
      trail.push({ col: ev.col, row: ev.row });
      if (ev.press && ev.name !== 'motion') {
        const ch = ev.name === 'left' ? 'X' : ev.name === 'right' ? 'R' : ev.name.startsWith('wheel') ? '~' : 'o';
        marks.push({ col: ev.col, row: ev.row, ch });
      }
    }

    if (other.length) {
      rawChunks.push(hex(other));
      const s = other.toString('latin1');
      if (s.includes('q') || s.includes('\x03') || s.includes('\x1b\x1b')) return finish();
    }
    render();
  });

  process.on('SIGINT', finish);
  process.on('SIGTERM', finish);
  out.on('resize', () => { out.write('\x1b[2J'); render(); });

  render();
}

main();
