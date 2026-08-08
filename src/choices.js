'use strict';

const { stripAnsi } = require('./message');

// Answering a multiple-choice prompt means sending a keypress, not text, so
// the key has to be exactly right. This parser only reports options whose key
// the agent printed on screen next to them. If any option lacks one, it
// reports nothing and the town falls back to jumping into the pane.
//
// Deliberately absent: any attempt to answer arrow-navigated forms by counting
// rows from the cursor. That would mean computing a keystroke rather than
// reading it, and a miscount approves an action the user did not choose.

const CURSOR = '[❯>›▶*•]';

// Each matcher must capture the key the agent printed and the label beside it.
const PATTERNS = [
  {
    // "❯ 1. Yes"  /  "2) No"
    id: 'numbered',
    re: new RegExp(`^\\s*(?:${CURSOR}\\s*)?(\\d)[.)]\\s+(\\S.*)$`),
    key: (m) => m[1],
    label: (m) => m[2],
  },
  {
    // "[y] yes"  /  "(n) no"
    id: 'bracket-lead',
    re: new RegExp(`^\\s*(?:${CURSOR}\\s*)?[[(]([A-Za-z0-9])[\\])]\\s+(\\S.*)$`),
    key: (m) => m[1],
    label: (m) => m[2],
  },
  {
    // Cursor's shape: "Run (once) (y)" / "Skip (esc or n)" — key in trailing
    // parens. The last parenthesised group wins, since earlier ones are prose.
    id: 'trailing-paren',
    re: new RegExp(`^\\s*(?:${CURSOR}\\s*)?(\\S.*?)\\s*\\(([^()]{1,14})\\)\\s*$`),
    key: (m) => extractKey(m[2]),
    label: (m) => m[1],
  },
];

// "y" -> y.  "esc or n" -> esc.  "enter" -> enter.  Anything ambiguous -> null,
// which disqualifies the whole prompt rather than guessing.
function extractKey(text) {
  const t = String(text).trim().toLowerCase();
  if (/^[a-z0-9]$/.test(t)) return t;
  if (t === 'esc' || t === 'escape') return 'esc';
  if (t === 'enter' || t === 'return') return 'enter';
  const m = /^(?:esc|escape)\s+or\s+([a-z0-9])$/.exec(t);
  if (m) return 'esc';
  const first = /^([a-z0-9])\s+or\s+/.exec(t);
  if (first) return first[1];
  return null;
}

function cleanLabel(s) {
  return String(s)
    .replace(/\s*\((?:esc|escape|enter|return)\)\s*$/i, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 90);
}

// Options must all come from the same matcher. A screen where one line looks
// numbered and another looks bracketed is far more likely to be prose that
// happens to resemble a menu than an actual menu.
function collect(lines, pattern) {
  const found = [];
  for (let i = 0; i < lines.length; i++) {
    const m = pattern.re.exec(lines[i]);
    if (!m) continue;
    const key = pattern.key(m);
    const label = cleanLabel(pattern.label(m));
    if (!key || !label) continue;
    found.push({ key, label, row: i });
  }
  return found;
}

// Consecutive-ish: a menu's options sit together. Rejecting scattered matches
// keeps numbered prose ("1. First we..." three paragraphs apart) out.
function longestRun(options, maxGap = 2) {
  if (!options.length) return [];
  let best = [options[0]];
  let cur = [options[0]];
  for (let i = 1; i < options.length; i++) {
    if (options[i].row - options[i - 1].row <= maxGap) cur.push(options[i]);
    else cur = [options[i]];
    if (cur.length > best.length) best = cur;
  }
  return best;
}

function signatureOf(question, options) {
  return `${question}|${options.map((o) => `${o.key}:${o.label}`).join('|')}`;
}

// Parse a screen into an answerable prompt, or null. `blocked` is Herdr's own
// judgement that the agent is waiting on someone; this only decides what the
// options are, never whether a prompt exists.
function parseChoices(raw, { maxLines = 22 } = {}) {
  const all = stripAnsi(raw).replace(/\r/g, '').split('\n');
  const tail = all.slice(-maxLines);

  let best = null;
  for (const pattern of PATTERNS) {
    const run = longestRun(collect(tail, pattern));
    if (run.length < 2) continue;
    // Duplicate keys mean we parsed something that is not a menu.
    if (new Set(run.map((o) => o.key)).size !== run.length) continue;
    if (!best || run.length > best.options.length) {
      best = { pattern: pattern.id, options: run };
    }
  }
  if (!best) return null;

  // The question is the nearest non-empty line above the first option that is
  // not itself an option.
  const firstRow = best.options[0].row;
  let question = '';
  for (let i = firstRow - 1; i >= 0 && firstRow - i <= 6; i--) {
    const t = tail[i].trim();
    if (!t) continue;
    if (best.options.some((o) => o.row === i)) continue;
    question = t.slice(0, 120);
    break;
  }

  const options = best.options.map((o) => ({ key: o.key, label: o.label }));
  return {
    question,
    options,
    pattern: best.pattern,
    signature: signatureOf(question, options),
  };
}

module.exports = { parseChoices, signatureOf, extractKey };
