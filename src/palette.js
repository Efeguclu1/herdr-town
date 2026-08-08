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
// Herdr ships detection manifests for 19 agent CLIs and people run others
// besides, so these are spread around the hue circle rather than picked ad hoc:
// the old table had seven pairs sharing a colour, including codex and cursor
// both reading as blue.
//
// Values stay saturated and above a brightness floor, because a 9px worker has
// to read against a midnight sky as well as a noon one: a dark blue agent on a
// dark blue night is invisible. The familiar ones are pinned: claude is
// orange because it has always been orange.
const AGENT_COLORS = {
  // reds through yellows
  kimi: 0xe04b5a,
  claude: 0xef7d57,
  amp: 0xc4761f,
  opencode: 0xffcd75,
  // olive through greens
  hermes: 0x9aa83f,
  copilot: 0xa7f070,
  codex: 0x38b764,
  kilo: 0x7fe8c0,
  // cyans through blues
  cline: 0x35c2c2,
  qodercli: 0x73eff7,
  cursor: 0x41a6f6,
  gemini: 0x4a63d8,
  // indigos through pinks
  kiro: 0x7b5fe0,
  agy: 0xa87ff0,
  droid: 0xb84fc8,
  maki: 0xe05fa8,
  pi: 0xf5a8c0,
  // neutrals
  devin: 0x8296b5,
  grok: 0xf4f4f4,
  aider: 0xb0c4d4,
};

// Names Herdr may report differently from the manifest id.
const ALIASES = {
  'cursor-agent': 'cursor',
  qoder: 'qodercli',
  'claude-code': 'claude',
  'kimi-code': 'kimi',
  'gemini-cli': 'gemini',
  'copilot-cli': 'copilot',
  factory: 'droid',
  antigravity: 'agy',
};

// Reserve hues for agents that do not appear above, kept clear of the assigned
// ones so an unrecognised CLI still gets a colour of its own.
const FALLBACK = [
  0xb5651d, 0x8fbf3f, 0x2f8f6f, 0x4a7fb5,
  0x7f5fa8, 0xbf5f7f, 0xa88f4f, 0x5f8f8f,
];

function agentColor(name) {
  const raw = String(name || 'agent').toLowerCase().trim();
  const key = ALIASES[raw] || raw;
  if (AGENT_COLORS[key]) return AGENT_COLORS[key];
  // Unrecognised CLI: hash into the reserve rather than colliding with an
  // assigned colour, which is what the old fallback did.
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
