'use strict';

// Sweetie-16: a classic 16-colour 8-bit palette. Everything on screen comes
// from these, which is most of why the result reads as pixel art rather than
// as "a terminal with colours in it".
const P = {
  black: 0x1a1c2c,
  purple: 0x5d275d,
  red: 0xb13e53,
  orange: 0xef7d57,
  yellow: 0xffcd75,
  lime: 0xa7f070,
  green: 0x38b764,
  teal: 0x257179,
  navy: 0x29366f,
  blue: 0x3b5dc9,
  sky: 0x41a6f6,
  cyan: 0x73eff7,
  white: 0xf4f4f4,
  grey: 0x94b0c2,
  slate: 0x566c86,
  dark: 0x333c57,
};

// Agents get a signature colour so you can tell workers apart at a glance.
// Anything unrecognised hashes into the palette rather than falling back to a
// single "other" colour.
const AGENT_COLORS = {
  claude: P.orange,
  codex: P.cyan,
  cursor: P.sky,
  copilot: P.lime,
  gemini: P.blue,
  droid: P.purple,
  opencode: P.yellow,
  grok: P.white,
  devin: P.teal,
  qoder: P.green,
  kimi: P.red,
  pi: P.lime,
  aider: P.grey,
};

const FALLBACK = [P.lime, P.yellow, P.cyan, P.sky, P.purple, P.red, P.teal, P.grey];

function agentColor(name) {
  const key = String(name || 'agent').toLowerCase();
  if (AGENT_COLORS[key]) return AGENT_COLORS[key];
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) >>> 0;
  return FALLBACK[h % FALLBACK.length];
}

// Blend two colours; t=0 returns a, t=1 returns b. Used for the sky gradient
// and for dimming distant scenery.
function mix(a, b, t) {
  const k = Math.max(0, Math.min(1, t));
  const ar = (a >> 16) & 255, ag = (a >> 8) & 255, ab = a & 255;
  const br = (b >> 16) & 255, bg = (b >> 8) & 255, bb = b & 255;
  const r = Math.round(ar + (br - ar) * k);
  const g = Math.round(ag + (bg - ag) * k);
  const bl = Math.round(ab + (bb - ab) * k);
  return (r << 16) | (g << 8) | bl;
}

module.exports = { P, agentColor, mix };
