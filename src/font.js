'use strict';

// A 3x5 bitmap font, drawn straight onto the pixel canvas. Terminal text can
// only sit on cell boundaries; this can float anywhere in the scene, which is
// what nameplates over workers need.
const GLYPHS = {
  A: '.#.|#.#|###|#.#|#.#',
  B: '##.|#.#|##.|#.#|##.',
  C: '.##|#..|#..|#..|.##',
  D: '##.|#.#|#.#|#.#|##.',
  E: '###|#..|##.|#..|###',
  F: '###|#..|##.|#..|#..',
  G: '.##|#..|#.#|#.#|.##',
  H: '#.#|#.#|###|#.#|#.#',
  I: '###|.#.|.#.|.#.|###',
  J: '..#|..#|..#|#.#|.#.',
  K: '#.#|#.#|##.|#.#|#.#',
  L: '#..|#..|#..|#..|###',
  M: '#.#|###|###|#.#|#.#',
  N: '#.#|##.|###|.##|#.#',
  O: '.#.|#.#|#.#|#.#|.#.',
  P: '##.|#.#|##.|#..|#..',
  Q: '.#.|#.#|#.#|##.|.##',
  R: '##.|#.#|##.|#.#|#.#',
  S: '.##|#..|.#.|..#|##.',
  T: '###|.#.|.#.|.#.|.#.',
  U: '#.#|#.#|#.#|#.#|###',
  V: '#.#|#.#|#.#|#.#|.#.',
  W: '#.#|#.#|###|###|#.#',
  X: '#.#|#.#|.#.|#.#|#.#',
  Y: '#.#|#.#|.#.|.#.|.#.',
  Z: '###|..#|.#.|#..|###',
  0: '.#.|#.#|#.#|#.#|.#.',
  1: '.#.|##.|.#.|.#.|###',
  2: '##.|..#|.#.|#..|###',
  3: '##.|..#|.#.|..#|##.',
  4: '#.#|#.#|###|..#|..#',
  5: '###|#..|##.|..#|##.',
  6: '.##|#..|###|#.#|###',
  7: '###|..#|.#.|.#.|.#.',
  8: '###|#.#|###|#.#|###',
  9: '###|#.#|###|..#|##.',
  '-': '...|...|###|...|...',
  '.': '...|...|...|...|.#.',
  ':': '...|.#.|...|.#.|...',
  '!': '.#.|.#.|.#.|...|.#.',
  '?': '##.|..#|.#.|...|.#.',
  '+': '...|.#.|###|.#.|...',
  '/': '..#|..#|.#.|#..|#..',
  '…': '...|...|...|...|#.#',
  ' ': '...|...|...|...|...',
};

const GLYPH_W = 3;
const GLYPH_H = 5;
const TRACKING = 1;

const CACHE = new Map();
function glyph(ch) {
  if (CACHE.has(ch)) return CACHE.get(ch);
  const raw = GLYPHS[ch] || GLYPHS['?'];
  const rows = raw.split('|');
  CACHE.set(ch, rows);
  return rows;
}

// Fold accents to their base letter before looking up glyphs, so Turkish text
// renders as BAGLI rather than BA?LI. NFD splits "ğ" into "g" + a combining
// breve; dropping the combining marks leaves the base letter. Covers Turkish
// (ç ğ ı İ ö ş ü) and most European accents with no per-language table.
function fold(text) {
  return String(text)
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/ı/g, 'i')
    .replace(/İ/g, 'I')
    .toUpperCase();
}

function normalize(text) {
  return fold(text).split('').map((c) => (GLYPHS[c] ? c : '?')).join('');
}

// Greedy word wrap, in glyph counts rather than pixels. Words longer than the
// line get hard-split rather than overflowing the bubble.
function wrap(text, maxChars, maxLines = 3) {
  const words = fold(text).split(/\s+/).filter(Boolean);
  const lines = [];
  let cur = '';
  for (const word of words) {
    if (!cur) {
      cur = word;
    } else if (cur.length + 1 + word.length <= maxChars) {
      cur += ` ${word}`;
    } else {
      lines.push(cur);
      cur = word;
    }
    while (cur.length > maxChars) {
      lines.push(cur.slice(0, maxChars));
      cur = cur.slice(maxChars);
    }
    if (lines.length >= maxLines) break;
  }
  if (cur && lines.length < maxLines) lines.push(cur);

  if (lines.length > maxLines) lines.length = maxLines;
  // Mark truncation on the last line so a clipped question reads as clipped.
  const usedAll = lines.join(' ').length >= fold(text).replace(/\s+/g, ' ').length;
  if (!usedAll && lines.length) {
    const last = lines[lines.length - 1];
    lines[lines.length - 1] = last.length >= maxChars
      ? `${last.slice(0, Math.max(0, maxChars - 1))}…`
      : `${last}…`;
  }
  return lines;
}

function textWidth(text) {
  const n = String(text).length;
  return n === 0 ? 0 : n * (GLYPH_W + TRACKING) - TRACKING;
}

function drawText(cv, x, y, text, color) {
  const s = normalize(text);
  let cx = x;
  for (const ch of s) {
    const rows = glyph(ch);
    for (let j = 0; j < GLYPH_H; j++) {
      const row = rows[j];
      for (let i = 0; i < GLYPH_W; i++) {
        if (row[i] === '#') cv.set(cx + i, y + j, color);
      }
    }
    cx += GLYPH_W + TRACKING;
  }
  return textWidth(s);
}

// Text on a solid plate, so a nameplate stays readable over any background.
function drawPlate(cv, cx, y, text, fgColor, bgColor) {
  const w = textWidth(normalize(text));
  const x = Math.round(cx - w / 2);
  cv.rect(x - 2, y - 1, w + 4, GLYPH_H + 2, bgColor);
  drawText(cv, x, y, text, fgColor);
  return { x: x - 2, w: w + 4, h: GLYPH_H + 2 };
}

// Raw glyph rows for a character, for renderers that are not the Canvas
// (the PNG preview needs to draw text cells into an image buffer).
function glyphFor(ch) {
  return glyph(normalize(ch)[0] || ' ');
}

module.exports = {
  drawText, drawPlate, textWidth, normalize, fold, wrap, glyphFor,
  GLYPH_W, GLYPH_H, TRACKING,
};
