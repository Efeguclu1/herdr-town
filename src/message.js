'use strict';

const { execFile } = require('node:child_process');

const BIN = process.env.HERDR_BIN_PATH || 'herdr';

// How long a fetched screen stays fresh. The render loop runs at ~12fps and
// must never shell out, so it only ever reads the cache.
const TTL_MS = 3000;
// Never have more than this many `herdr agent read` processes in flight.
const MAX_INFLIGHT = 3;
const FETCH_TIMEOUT_MS = 4000;

// Characters agents use to draw rules and boxes. Claude Code uses ─, Cursor
// uses ▀ and ▄, others use ═ or ━. Detecting "this line is a drawn rule"
// covers all of them without knowing which agent produced it.
const BOX_CHARS = new Set(
  ('─━│┃┄┅┆┇┈┉┊┋┌┍┎┏┐┑┒┓└┕┖┗┘┙┚┛├┝┞┟┠┡┢┤┥┦┧┨┩┪┬┭┮┯┰┱┲┴┵┶┷┸┹┺┼╀╁╂╃╄╅╆╇╈╉╊╋'
  + '═║╒╓╔╕╖╗╘╙╚╛╜╝╞╟╠╡╢╣╤╥╦╧╨╩╪╫╬'
  + '▀▁▂▃▄▅▆▇█▉▊▋▌▍▎▏▐░▒▓▔▕▖▗▘▙▚▛▜▝▞▟'
  + '■□▪▫▬▭▮▯').split(''),
);

const ANSI_RE = /\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;

function stripAnsi(s) {
  return String(s).replace(ANSI_RE, '');
}

// A "rule" is a long run of box-drawing characters: the border of an agent's
// input box. Both Claude Code and Cursor bracket their input area with these,
// which is what makes the split below work across agents.
function isRule(line) {
  const t = line.trim();
  if (t.length < 12) return false;
  let box = 0;
  for (const ch of t) if (BOX_CHARS.has(ch)) box++;
  return box / t.length >= 0.8;
}

// Agent chrome that is not a rule: status bars, spinners, hints.
function isChrome(line) {
  const t = line.trim();
  if (!t) return false;

  // Input prompt lines: "❯ ", "› ", "→ Add a follow-up", "> ".
  if (/^[❯›→▶>]\s/.test(t) || /^[❯›→▶>]$/.test(t)) return true;

  // Spinner / "still working" lines: "✻ Sautéed for 29m 36s",
  // "✳ Synthesizing… (2m 25s · ↓ 3.3k tokens)", "⏺ Working (12s)".
  //
  // Agents cycle through a whole family of glyphs for these, so match the
  // shape rather than enumerating them: a leading symbol, then an elapsed
  // time or a token counter.
  if (/^[^\p{L}\p{N}\s]\s/u.test(t)
    && (/\(\d+\s*[msh]/.test(t) || /\b\d+\s*[smh]\b/.test(t)
      || /\d+(\.\d+)?k?\s*tokens/i.test(t))) return true;

  // A bare elapsed-time counter on its own line: "(4s)", "2m 25s", "(1m 3s)".
  // Nothing but furniture ever looks like this, and it leaks into bubbles.
  if (/^\(?\d+\s*[smh](\s*\d+\s*[smh])?\)?$/.test(t)) return true;

  // Token/interrupt counters anywhere on the line.
  if (/[↓↑]\s*[\d.]+k?\s*tokens/i.test(t)) return true;
  if (/\besc to interrupt\b/i.test(t)) return true;

  // Mode / hint lines.
  if (/^⏸/.test(t)) return true;
  if (/^\?\s*for shortcuts$/i.test(t)) return true;
  if (/new task\?|\/clear to save|to save \d+(\.\d+)?k tokens/i.test(t)) return true;
  if (/^\d+\s+tasks?$/i.test(t)) return true;

  // System notices: a leading glyph plus middot-separated metadata, such as
  // "▎ Using Opus 5 (from .claude/settings.json) · /model". One middot is
  // enough here because prose almost never opens with a symbol. List markers
  // are excluded so a genuine bullet is never mistaken for furniture.
  if (/^[^\p{L}\p{N}\s\-*+•·>]/u.test(t) && t.includes('·')) return true;

  // Status bars: middot-separated metadata like
  // "Cursor Grok 4.5 High Fast · 40.1% · 6 files edited".
  if ((t.match(/·/g) || []).length >= 2 && t.length < 160) return true;

  // Trailing cwd/branch footer: "~/Klinika · e3-reports-csv" (also caught
  // above, but a single-middot path line is common enough to name).
  if (/^~?[\w./~-]+\s+·\s+\S+$/.test(t)) return true;

  return false;
}

// Split a screen into the transcript above the agent's input box and the
// chrome below it.
//
// Both Claude Code and Cursor render: <transcript> RULE <input> RULE <status>.
// So find the trailing cluster of rules and cut at the topmost one. Everything
// above is what the agent actually said.
function splitAtInputBox(lines) {
  let lastRule = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (isRule(lines[i])) { lastRule = i; break; }
  }
  if (lastRule < 0) return { transcript: lines, cut: lines.length };

  // Walk up through the input box to the rule that opens it. The box is a
  // handful of lines, so bound the search rather than scanning the screen.
  let cut = lastRule;
  for (let i = lastRule - 1, seen = 0; i >= 0 && seen < 8; i--, seen++) {
    if (isRule(lines[i])) { cut = i; seen = 0; }
  }
  return { transcript: lines.slice(0, cut), cut };
}

// A keyboard hint bar: "esc to cancel · ctrl+e to explain · enter to send".
// Two or more key names, short, and not asking anything.
//
// Only ever applied to the last few lines. An approval prompt such as
// "Run this command? yes (y) / no (n)" looks similar but is the very thing
// you need to read, and it sits above the input box rather than below it.
const KEY_HINT = /(?:\besc\b|\benter\b|\btab\b|\bspace\b|ctrl\+\w|alt\+\w|shift\+\w|\((?:y|n)\))/gi;

function isHintBar(line) {
  const t = line.trim();
  if (!t || t.length > 90 || t.includes('?')) return false;
  const hits = t.match(KEY_HINT);
  return !!hits && hits.length >= 2;
}

// Turn a raw screen into the last thing the agent said.
// Deliberately dumb: no per-agent parsing, no attempt to identify speakers.
// It removes what is provably furniture and lets your eyes do the rest.
function extract(raw, { maxLines = 40 } = {}) {
  const all = stripAnsi(raw).replace(/\r/g, '').split('\n');
  const split = splitAtInputBox(all);
  let { transcript } = split;

  // Agents that bracket their input with box-drawing rules (Claude Code,
  // Cursor) are handled by the split above. Agents that just print a bare
  // prompt leave their status and hint bars in the transcript, so trim any
  // trailing furniture directly.
  if (split.cut >= all.length) {
    let end = transcript.length;
    for (let i = transcript.length - 1, checked = 0; i >= 0 && checked < 6; i--, checked++) {
      const line = transcript[i];
      if (!line.trim()) { end = i; continue; }
      if (isChrome(line) || isHintBar(line)) { end = i; checked = 0; continue; }
      break;
    }
    transcript = transcript.slice(0, end);
  }

  const kept = [];
  for (const line of transcript) {
    if (isRule(line) || isChrome(line)) continue;
    const trimmedRight = line.replace(/\s+$/, '');
    // Collapse runs of blank lines to one.
    if (!trimmedRight.trim()) {
      if (kept.length && kept[kept.length - 1] !== '') kept.push('');
      continue;
    }
    kept.push(trimmedRight);
  }

  while (kept.length && kept[kept.length - 1] === '') kept.pop();
  while (kept.length && kept[0] === '') kept.shift();

  // Agents indent their prose; strip the common leading indent so the text
  // wraps cleanly in a narrow panel.
  const indents = kept.filter((l) => l.trim()).map((l) => l.match(/^ */)[0].length);
  const common = indents.length ? Math.min(...indents) : 0;
  const dedented = common > 0 ? kept.map((l) => l.slice(common)) : kept;

  const body = dedented.slice(-maxLines);
  return {
    lines: body,
    text: body.join('\n'),
    empty: body.length === 0,
  };
}

// Lines that begin a block of tool output rather than something the agent
// said. Agents mark these with a leading glyph; the glyph varies but the role
// does not, so this stays a shape rule rather than a per-agent rule.
const TOOL_LINE = /^[⎿⏺⧉│┃⊹⊙]/;
// Diff and line-numbered code output: "129 +// comment", "+  const x = 1".
// Prose never looks like this, and agents emit a lot of it.
const CODE_LINE = /^\s*(\d+\s*[+\-|]|[+\-]{1,2}\s|@@ )/;
// Decorative leading glyphs to peel off a chosen teaser.
const LEAD_GLYPH = /^[※✻✽✢⏺⎿⧉●○▪◆✱∗*·]+\s*/;
const LABEL_PREFIX = /^(recap|note|summary)\s*:\s*/i;

// One line worth of teaser for a speech bubble. Prefers a question, because a
// blocked agent's question is the whole reason to look at the town.
function summarize(lines, maxChars = 60) {
  const paragraphs = [];
  let cur = [];
  for (const l of lines) {
    if (!l.trim()) { if (cur.length) { paragraphs.push(cur); cur = []; } continue; }
    cur.push(l.trim());
  }
  if (cur.length) paragraphs.push(cur);
  if (!paragraphs.length) return '';

  // Prose beats tool output. Only fall back to tool output if there is nothing
  // else on screen.
  const prose = paragraphs.filter((p) => !TOOL_LINE.test(p[0]) && !CODE_LINE.test(p[0]));
  const pool = prose.length ? prose : paragraphs;

  const asking = [...pool].reverse().find((p) => p.join(' ').includes('?'));
  const chosen = asking || pool[pool.length - 1];

  const joined = chosen.join(' ')
    .replace(/\s+/g, ' ')
    .replace(LEAD_GLYPH, '')
    .replace(LABEL_PREFIX, '')
    .trim();

  if (joined.length <= maxChars) return joined;
  const cut = joined.slice(0, maxChars);
  const lastSpace = cut.lastIndexOf(' ');
  return `${(lastSpace > maxChars * 0.6 ? cut.slice(0, lastSpace) : cut).trim()}…`;
}

function readPane(paneId) {
  return new Promise((resolve, reject) => {
    execFile(
      BIN,
      ['agent', 'read', paneId, '--source', 'visible', '--format', 'text'],
      { timeout: FETCH_TIMEOUT_MS, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err && !stdout) return reject(new Error(stderr || err.message));
        resolve(String(stdout));
      },
    );
  });
}

// Per-pane cache of extracted messages. The view asks for a pane and gets
// whatever is cached right now, never a promise; refreshes happen behind it.
class MessageCache {
  constructor({ ttlMs = TTL_MS } = {}) {
    this.ttlMs = ttlMs;
    this.entries = new Map(); // paneId -> {lines, text, summary, at, error, fetching}
    this.inflight = 0;
  }

  // Non-blocking. Returns the cached entry (possibly stale, possibly missing)
  // and schedules a refresh when it has aged out.
  get(paneId) {
    const e = this.entries.get(paneId);
    const now = Date.now();
    if (!e || now - e.at > this.ttlMs) this.schedule(paneId);
    return e || null;
  }

  schedule(paneId) {
    const e = this.entries.get(paneId);
    if (e && e.fetching) return;
    if (this.inflight >= MAX_INFLIGHT) return;

    const entry = e || {
      lines: [], text: '', summary: '', detail: '', raw: '', at: 0, error: null,
    };
    entry.fetching = true;
    this.entries.set(paneId, entry);
    this.inflight++;

    readPane(paneId)
      .then((raw) => {
        const { lines, text, empty } = extract(raw);
        // Choice prompts are parsed from the raw screen, not from `lines`:
        // extract() strips "❯ 1. Yes" as an input-prompt line.
        entry.raw = String(raw).slice(-8000);
        entry.lines = lines;
        entry.text = text;
        entry.summary = summarize(lines);
        // Bubbles hold several lines of real text, so they get a fuller
        // version of the same paragraph rather than the footer's one-liner.
        entry.detail = summarize(lines, 220);
        entry.error = empty ? 'no output on screen' : null;
      })
      .catch((err) => {
        entry.lines = [];
        entry.text = '';
        entry.summary = '';
        entry.detail = '';
        entry.raw = '';
        entry.error = err.message.split('\n')[0].slice(0, 120);
      })
      .finally(() => {
        entry.at = Date.now();
        entry.fetching = false;
        this.inflight--;
      });
  }

  // Await a fetch. The view never uses this (it must not block), but one-shot
  // rendering and tests need to know the message has actually landed.
  async ensure(paneId, timeoutMs = 5000) {
    this.schedule(paneId);
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const e = this.entries.get(paneId);
      if (e && !e.fetching && e.at > 0) return e;
      await new Promise((r) => setTimeout(r, 50));
      this.schedule(paneId);
    }
    return this.entries.get(paneId) || null;
  }

  // Drop panes that no longer exist so the cache cannot grow without bound.
  retain(paneIds) {
    const keep = new Set(paneIds);
    for (const id of this.entries.keys()) if (!keep.has(id)) this.entries.delete(id);
  }
}

module.exports = {
  MessageCache, extract, summarize, isRule, isChrome, isHintBar,
  splitAtInputBox, stripAnsi,
};
