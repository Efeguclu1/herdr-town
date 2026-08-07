'use strict';

const { P, agentColor, mix } = require('./palette');
const { WORKER_POSES, bubbleBang, zzz, tree } = require('./sprites');
const {
  drawPlate, drawText, textWidth, normalize, wrap, GLYPH_H,
} = require('./font');
const daylight = require('./daylight');

// Deterministic noise, so stars, window lighting and tree placement stay put
// between frames instead of shimmering.
function hash(...args) {
  let h = 2166136261;
  for (const a of args) {
    const s = typeof a === 'string' ? a : String(a);
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    h ^= 0x9e;
    h = Math.imul(h, 16777619);
  }
  return ((h >>> 0) % 100000) / 100000;
}

const STATE_COLOR = {
  working: P.lime,
  blocked: P.red,
  done: P.cyan,
  idle: P.slate,
  unknown: P.dark,
  complete: P.green, // shipped, still standing
  ruin: P.dark,      // abandoned before it was finished
};

// ---------------------------------------------------------------- backdrop

function drawSky(cv, groundY, frame, sky) {
  // Three-stop gradient: sunsets need a warm band at the horizon that a
  // straight top-to-bottom blend cannot give.
  for (let y = 0; y < groundY; y++) {
    const t = y / Math.max(1, groundY - 1);
    const c = t < 0.55
      ? mix(sky.top, sky.mid, t / 0.55)
      : mix(sky.mid, sky.bottom, (t - 0.55) / 0.45);
    cv.hline(0, y, cv.w, c);
  }

  // Stars fade in as it gets dark rather than snapping on.
  if (sky.starAlpha > 0.02) {
    const starRows = Math.max(1, Math.floor(groundY * 0.62));
    for (let x = 0; x < cv.w; x++) {
      const r = hash('star', x);
      if (r > 0.06 * sky.starAlpha + 0.005) continue;
      const y = Math.floor(hash('stary', x) * starRows);
      const tw = (Math.floor(frame / 6) + x) % 7;
      const base = tw === 0 ? P.white : P.grey;
      cv.set(x, y, mix(sky.top, base, Math.min(1, sky.starAlpha)));
    }
  }

  drawCelestialBody(cv, groundY, sky);
  if (sky.darkness < 0.5) drawClouds(cv, groundY, frame, sky);
}

// Sun by day, crescent moon by night, both arcing across the sky on the real
// clock so the town reads as a time as well as a place.
function drawCelestialBody(cv, groundY, sky) {
  const margin = 10;
  const x = Math.round(margin + sky.bodyT * (cv.w - margin * 2));
  const arc = Math.sin(sky.bodyT * Math.PI);
  const y = Math.round(groundY - 6 - arc * (groundY * 0.72));
  if (y > groundY - 3) return; // still below the horizon

  if (sky.isDay) {
    const r = 4;
    for (let j = -r; j <= r; j++) {
      for (let i = -r; i <= r; i++) {
        if (i * i + j * j > r * r) continue;
        cv.set(x + i, y + j, sky.sunColor);
      }
    }
    // A soft corona, stronger when the sun is low and red.
    const glow = mix(sky.bottom, sky.sunColor, 0.45);
    for (let j = -r - 1; j <= r + 1; j++) {
      for (let i = -r - 1; i <= r + 1; i++) {
        const d = i * i + j * j;
        if (d > (r + 1) * (r + 1) || d <= r * r) continue;
        cv.set(x + i, y + j, glow);
      }
    }
  } else {
    for (let j = -4; j <= 4; j++) {
      for (let i = -4; i <= 4; i++) {
        if (i * i + j * j > 16) continue;
        if ((i + 3) * (i + 3) + j * j < 15) continue; // bite out a crescent
        cv.set(x + i, y + j, P.yellow);
      }
    }
  }
}

// Daytime clouds, drifting slowly. Deterministic per cloud so they do not
// twitch between frames.
function drawClouds(cv, groundY, frame, sky) {
  const alpha = 1 - sky.darkness * 2; // gone by the time dusk arrives
  if (alpha <= 0) return;
  const color = mix(sky.mid, P.white, 0.55 * alpha);
  const shade = mix(sky.mid, P.white, 0.3 * alpha);
  const count = 3;
  for (let c = 0; c < count; c++) {
    const speed = 0.05 + hash('cloudspd', c) * 0.05;
    const span = cv.w + 40;
    const x = Math.round(((hash('cloudx', c) * span) + frame * speed) % span) - 20;
    const y = Math.round(4 + hash('cloudy', c) * groundY * 0.35);
    const w = 10 + Math.floor(hash('cloudw', c) * 10);
    cv.hline(x, y + 1, w, color);
    cv.hline(x + 2, y, w - 5, color);
    cv.hline(x + 1, y + 2, w - 2, shade);
  }
}

function drawHills(cv, groundY, sky) {
  const base = groundY;
  for (let x = 0; x < cv.w; x++) {
    const h1 = 5 + Math.round(4 * Math.sin(x / 13) + 2 * Math.sin(x / 5));
    for (let y = base - h1; y < base; y++) cv.set(x, y, sky.hill);
  }
}

function drawGround(cv, groundY, sky) {
  cv.hline(0, groundY, cv.w, sky.ground);
  cv.rect(0, groundY + 1, cv.w, cv.h - groundY - 1, mix(sky.ground, P.black, 0.45));
  // A path running through the town.
  const roadY = groundY + 4;
  if (roadY < cv.h) {
    const road = mix(P.slate, P.black, 0.15 + sky.darkness * 0.35);
    cv.hline(0, roadY, cv.w, road);
    cv.hline(0, roadY + 1, cv.w, mix(road, P.black, 0.35));
    for (let x = 2; x < cv.w; x += 8) cv.set(x, roadY, mix(P.yellow, road, sky.darkness * 0.5));
  }
}

// ---------------------------------------------------------------- buildings

// Where the horizon sits. Proportional, so a tall pane gets a tall town
// instead of a strip of buildings pinned to the bottom edge.
function groundLine(cvH) {
  return Math.round(cvH * 0.78);
}

// Storey height scales with the pane, so a tall terminal gets tall buildings
// rather than the same short ones under a lot of empty sky.
function floorH(cvH) {
  return Math.max(4, Math.round(cvH * 0.06));
}

function buildingHeight(floors, fh) {
  return floors * fh + 3;
}

function drawBuilding(cv, x, groundY, w, b, frame, sky) {
  const accent = STATE_COLOR[b.state] || P.slate;
  const FLOOR_H = floorH(cv.h);
  const h = buildingHeight(b.floors, FLOOR_H);
  const top = groundY - h;

  const ruin = b.state === 'ruin';
  const complete = b.state === 'complete';

  const wall = ruin
    ? mix(P.slate, P.black, 0.68)
    : mix(P.slate, P.black, b.state === 'idle' ? 0.45 : complete ? 0.18 : 0.25);
  const wallShade = mix(wall, P.black, 0.35);

  // Body, with a shaded right edge so it reads as a solid volume. A ruin's
  // top courses are eaten away instead of being drawn flat.
  for (let j = 0; j < h; j++) {
    const eroding = ruin && j < 3;
    for (let i = 0; i < w; i++) {
      if (eroding && hash(b.key, 'erode', i, j) > 0.3 + j * 0.25) continue;
      let c = wall;
      if (i === w - 1) c = wallShade;
      else if (i === 0) c = mix(wall, P.white, 0.12);
      cv.set(x + i, top + j, c);
    }
  }

  // Roof slab, overhanging by a pixel each side. Ruins have no intact roof.
  if (!ruin) {
    cv.hline(x - 1, top, w + 2, mix(accent, P.black, 0.45));
    cv.hline(x - 1, top - 1, w + 2, accent);
  }

  // Windows. Lighting says what the building is doing: a working building
  // flickers, a blocked one glows red, a shipped one is warmly lit, a ruin
  // is mostly empty sockets.
  const cols = Math.max(1, Math.floor((w - 2) / 4));
  for (let f = 0; f < b.floors; f++) {
    const wy = groundY - 3 - (f + 1) * FLOOR_H + 2;
    for (let c = 0; c < cols; c++) {
      const wx = x + 2 + c * 4;
      if (wx + 1 >= x + w - 1) continue;
      const seed = hash(b.key, f, c);
      let lit;
      if (b.state === 'working') lit = ((Math.floor(frame / 4) + f * 3 + c * 5) % 11) / 11 > seed * 0.7;
      else if (b.state === 'blocked') lit = seed > 0.35;
      else if (b.state === 'done') lit = true;
      else if (complete) lit = seed > 0.25;
      else if (ruin) lit = false;
      else if (b.state === 'idle') lit = seed > 0.78;
      else lit = seed > 0.9;

      const dark = sky ? sky.darkness : 1;
      let color;
      if (ruin) color = seed > 0.6 ? mix(P.black, P.navy, 0.25) : mix(P.black, P.slate, 0.3);
      else if (!lit) color = mix(P.black, P.navy, 0.5);
      else if (b.state === 'blocked') color = P.red;
      else if (b.state === 'done') color = P.cyan;
      else if (complete) color = mix(P.yellow, P.orange, 0.35);
      else color = P.yellow;
      // Lamps only read as lamps in the dark. By day a lit window is just
      // glass, so fade it toward the wall instead of glowing at noon.
      if (lit && !ruin) color = mix(mix(wall, color, 0.35), color, Math.max(0.25, dark));
      cv.rect(wx, wy, 2, 2, color);
    }
  }

  // Door. A ruin's is boarded up; a finished building keeps its light on.
  const dx = x + Math.floor(w / 2) - 1;
  cv.rect(dx, groundY - 3, 3, 3, mix(P.dark, P.black, ruin ? 0.6 : 0.3));
  if (ruin) {
    cv.set(dx, groundY - 2, P.slate);
    cv.set(dx + 2, groundY - 3, P.slate);
  } else {
    cv.set(dx + 2, groundY - 2, complete ? P.orange : P.yellow);
  }

  if (b.state === 'working') {
    drawScaffolding(cv, x, top, w, h, frame, FLOOR_H);
    drawCrane(cv, x, top, w, frame);
  }
  if (b.state === 'done' || complete) {
    drawFlag(cv, x + w - 3, top - 2, frame, complete ? P.green : P.cyan);
  }
  if (b.state === 'blocked') {
    // Hazard tape across the site.
    for (let i = 0; i < w; i++) {
      cv.set(x + i, groundY - 6, (i + Math.floor(frame / 3)) % 4 < 2 ? P.yellow : P.red);
    }
  }
  if (ruin) {
    // Rubble at the base, so the silhouette reads as abandoned, not just dark.
    for (let i = 0; i < w; i++) {
      if (hash(b.key, 'rubble', i) > 0.55) cv.set(x + i, groundY - 1, mix(P.slate, P.black, 0.5));
    }
  }
}

function drawScaffolding(cv, x, top, w, h, frame, FLOOR_H) {
  const pole = P.yellow;
  cv.vline(x - 2, top + 1, h - 1, pole);
  cv.vline(x + w + 1, top + 1, h - 1, pole);
  for (let y = top + 3; y < top + h; y += FLOOR_H) {
    cv.hline(x - 2, y, w + 4, mix(pole, P.black, 0.35));
  }
  // A worker platform sliding up and down the scaffold.
  const span = Math.max(1, h - 6);
  const py = top + 2 + Math.floor((Math.sin(frame / 14) * 0.5 + 0.5) * span);
  cv.hline(x - 2, py, 4, P.orange);
}

function drawCrane(cv, x, top, w, frame) {
  const cx = x + w + 1;
  const armY = top - 6;
  cv.vline(cx, armY, top - armY + 2, P.grey);
  const armLen = Math.min(10, w);
  cv.hline(cx - armLen, armY, armLen + 2, P.grey);
  // Load swinging on the hook.
  const swing = Math.round(Math.sin(frame / 9) * 2);
  const hx = cx - armLen + 2 + swing;
  const drop = 3 + Math.round(Math.sin(frame / 11) * 2);
  cv.vline(hx, armY + 1, drop, P.slate);
  cv.rect(hx - 1, armY + 1 + drop, 3, 2, P.orange);
}

function drawFlag(cv, x, y, frame, color) {
  cv.vline(x, y - 5, 6, P.grey);
  const wave = Math.floor(frame / 5) % 2;
  for (let j = 0; j < 3; j++) {
    const len = 4 - (wave && j === 1 ? 1 : 0);
    cv.hline(x + 1, y - 5 + j, len, color || P.cyan);
  }
}

// ---------------------------------------------------------------- workers

function poseFor(state, frame, seed) {
  switch (state) {
    case 'working':
      return (Math.floor(frame / 4) + Math.floor(seed * 4)) % 2 === 0 ? 'raise' : 'strike';
    case 'blocked':
      return 'armsUp';
    case 'done':
      return Math.floor(frame / 6) % 2 === 0 ? 'armsUp' : 'idle';
    case 'idle':
      return Math.floor(frame / 30) % 4 === 0 ? 'idle' : 'sleep';
    default:
      return 'idle';
  }
}

function drawWorker(cv, x, groundY, worker, frame, selected, showPlate = true) {
  const seed = hash(worker.paneId);
  const pose = poseFor(worker.state, frame, seed);
  const sp = WORKER_POSES[pose];
  const color = agentColor(worker.name);

  // A one-pixel bob keeps everyone alive-looking without being distracting.
  const bob = worker.state === 'working' && pose === 'strike' ? 1 : 0;
  const top = groundY - sp.h + bob;

  const overrides = { A: color };
  if (worker.state === 'unknown') {
    overrides.A = mix(color, P.black, 0.55);
    overrides.S = mix(P.yellow, P.black, 0.5);
  }
  cv.blit(sp, x, top, overrides);

  // Shadow.
  cv.hline(x + 2, groundY, 5, mix(P.green, P.black, 0.7));

  if (worker.state === 'blocked') {
    // Bubble pops in and out so a stalled agent pulses in your periphery.
    if (Math.floor(frame / 8) % 4 !== 3) cv.blit(bubbleBang, x + 5, top - 8);
  } else if (worker.state === 'idle') {
    const drift = Math.floor(frame / 10) % 3;
    cv.blit(zzz, x + 6, top - 4 - drift);
  } else if (worker.state === 'working') {
    // Sparks off the hammer on the strike frame.
    if (pose === 'strike') {
      for (let i = 0; i < 3; i++) {
        const sx = x + 8 + Math.round(Math.sin((frame + i * 3) / 2) * 2);
        const sy = top + 9 - i;
        cv.set(sx, sy, i === 0 ? P.white : P.yellow);
      }
    }
  } else if (worker.state === 'done') {
    // Confetti.
    for (let i = 0; i < 5; i++) {
      const cx = x + 1 + ((i * 3 + Math.floor(frame / 5)) % 8);
      const cy = top - 6 + ((i * 5 + Math.floor(frame / 3)) % 10);
      cv.set(cx, cy, [P.cyan, P.yellow, P.lime, P.orange, P.white][i % 5]);
    }
  }

  if (selected && showPlate) {
    // Nameplate just above the head: who this worker is, and therefore who
    // `enter` will take you to. Dark plate with coloured text so it sits over
    // the building without blotting it out.
    const bounce = Math.floor(frame / 8) % 2;
    const plateY = top - 10 - bounce;
    drawPlate(cv, x + 4, plateY, worker.name, color, mix(P.black, P.navy, 0.35));

    // Caret linking the plate to the worker.
    const by = plateY + 7;
    cv.set(x + 3, by, P.white);
    cv.set(x + 5, by, P.white);
    cv.set(x + 4, by + 1, P.white);
  }
}

// ------------------------------------------------------------ speech bubbles

const LINE_H = GLYPH_H + 2; // 5px glyph plus leading
const BUBBLE_PAD = 3;

// How many characters fit in a bubble on this canvas. Wide terminals get
// roomier bubbles; narrow ones stay legible rather than overflowing.
function bubbleChars(cvWidth) {
  // One canvas column is one character now, so bubbles can hold real sentences.
  return Math.max(16, Math.min(46, Math.floor(cvWidth * 0.32)));
}

// Plain greedy wrap for bubble text. Keeps the agent's own casing and
// punctuation, unlike the pixel font which had to fold to uppercase ASCII.
function wrapPlain(text, maxChars, maxLines) {
  const words = String(text).replace(/\s+/g, ' ').trim().split(' ');
  const out = [];
  let cur = '';
  for (const word of words) {
    const next = cur ? `${cur} ${word}` : word;
    if ([...next].length <= maxChars) { cur = next; continue; }
    if (cur) out.push(cur);
    cur = word;
    while ([...cur].length > maxChars) {
      out.push([...cur].slice(0, maxChars).join(''));
      cur = [...cur].slice(maxChars).join('');
    }
    if (out.length >= maxLines) break;
  }
  if (cur && out.length < maxLines) out.push(cur);
  if (out.length > maxLines) out.length = maxLines;
  const shown = out.join(' ').length;
  const full = String(text).replace(/\s+/g, ' ').trim().length;
  if (shown < full && out.length) {
    const last = [...out[out.length - 1]];
    out[out.length - 1] = last.length >= maxChars
      ? `${last.slice(0, maxChars - 1).join('')}…`
      : `${out[out.length - 1]}…`;
  }
  return out;
}

// Bubbles are a pixel frame around real terminal text. One canvas column is
// one terminal column, so a line of text costs 2 pixel rows instead of the 7 a
// 3x5 pixel-font line needs, and it is actually readable at sentence length.
const BUBBLE_PAD_X = 2;
const BUBBLE_PAD_Y = 2;

function measureBubble(lines, title) {
  const all = title ? [title, ...lines] : lines;
  const chars = all.length ? Math.max(...all.map((l) => [...l].length)) : 0;
  return {
    w: chars + BUBBLE_PAD_X * 2,
    h: all.length * 2 + BUBBLE_PAD_Y * 2,
    textRows: all.length,
  };
}

// Place bubbles so they do not sit on top of each other. Each starts at its
// preferred height and is pushed upward until it clears everything already
// placed. Without this, two blocked agents near each other produce one pile.
function layoutBubbles(cv, items) {
  const placed = [];
  const rank = (it) => (it.selected ? 2 : it.worker.state === 'blocked' ? 1 : 0);
  const ordered = [...items].sort((a, b) => rank(b) - rank(a) || a.cx - b.cx);

  for (const it of ordered) {
    const { w, h } = measureBubble(it.lines, it.title);
    let x = Math.round(it.cx - w / 2);
    x = Math.max(1, Math.min(Math.max(1, cv.w - w - 1), x));
    // Snap to an even pixel row so the interior lines land on cell boundaries.
    let y = (it.bottomY - h) & ~1;

    for (let guard = 0; guard < 8; guard++) {
      const clash = placed.find((p) => x < p.x + p.w + 2 && x + w + 2 > p.x
        && y < p.y + p.h + 3 && y + h + 3 > p.y);
      if (!clash) break;
      y = (clash.y - h - 4) & ~1;
    }
    if (y < 1) continue; // no room for the border; drop rather than clip

    it.box = { x, y, w, h };
    placed.push({ x, y, w, h });
  }
  return ordered.filter((it) => it.box);
}

function drawSpeechBubble(cv, cx, box, lines, opts) {
  const { fill, textColor, border, title } = opts;
  if (!lines.length || !box) return;
  const { x, y, w, h } = box;

  cv.rect(x, y, w, h, fill);
  cv.hline(x + 1, y - 1, w - 2, border);
  cv.hline(x + 1, y + h, w - 2, border);
  cv.vline(x - 1, y + 1, h - 2, border);
  cv.vline(x + w, y + 1, h - 2, border);
  // Knock the corners off so it reads as a rounded bubble, not a box.
  cv.set(x, y, border);
  cv.set(x + w - 1, y, border);
  cv.set(x, y + h - 1, border);
  cv.set(x + w - 1, y + h - 1, border);

  // Tail, pointing down at the worker.
  const tx = Math.max(x + 2, Math.min(x + w - 3, cx));
  cv.hline(tx - 1, y + h, 3, fill);
  cv.set(tx, y + h + 1, fill);
  cv.set(tx - 2, y + h, border);
  cv.set(tx + 2, y + h, border);
  cv.set(tx - 1, y + h + 1, border);
  cv.set(tx + 1, y + h + 1, border);
  cv.set(tx, y + h + 2, border);

  // When the bubble floats above the roof, dot a leader down to the worker so
  // it stays obvious who is speaking.
  if (opts.pointToY !== undefined) {
    for (let py = y + h + 4; py < opts.pointToY; py += 2) cv.set(tx, py, border);
  }

  // Real characters inside the pixel frame.
  const firstCellRow = (y + BUBBLE_PAD_Y) / 2;
  let row = firstCellRow;
  if (title) {
    cv.text(x + BUBBLE_PAD_X, row, title, border, fill);
    row += 1;
  }
  for (const line of lines) {
    cv.text(x + BUBBLE_PAD_X, row, line, textColor, fill);
    row += 1;
  }
}

// ---------------------------------------------------------------- town view

const WORKER_W = 9;
const WORKER_GAP = 7; // workers overlap slightly so a crowd still fits

function lotWidth(building) {
  // Standing buildings have no workers to make room for, so they pack tighter
  // and let more of the town's history fit on screen.
  if (!building.workers.length) return 15;
  const crowd = WORKER_W + (building.workers.length - 1) * WORKER_GAP;
  return Math.max(18, crowd + 8);
}

// Draw one town. Returns the lots actually drawn so the caller can align text
// labels underneath them.
function drawTown(cv, town, opts) {
  const { frame, scroll, selected, messageFor } = opts;
  const groundY = groundLine(cv.h);
  const sky = opts.sky || daylight.current();

  drawSky(cv, groundY, frame, sky);
  drawHills(cv, groundY, sky);
  drawGround(cv, groundY, sky);

  const buildings = town.buildingList;
  if (buildings.length === 0) {
    // An empty town still gets scenery, so it reads as "quiet" not "broken".
    for (let i = 0; i < Math.floor(cv.w / 18); i++) {
      cv.blit(tree, 6 + i * 18, groundY - 7);
    }
    return { lots: [], hits: [], scroll: 0 };
  }

  const widths = buildings.map(lotWidth);

  const margin = 3;
  const avail = cv.w - margin * 2;

  // How many lots fit starting at `from`.
  const fitFrom = (from) => {
    let n = 0;
    let acc = 0;
    for (let i = from; i < widths.length; i++) {
      if (acc + widths[i] > avail && n > 0) break;
      acc += widths[i];
      n++;
    }
    return { count: n, used: acc };
  };

  // Scroll so the selected lot is on screen. Lots have different widths, so
  // walk the offset rather than computing it.
  let start = Math.max(0, Math.min(scroll, buildings.length - 1));
  const target = selected ? Math.max(0, Math.min(selected.buildingIndex, buildings.length - 1)) : start;
  if (target < start) start = target;
  let { count: fit, used } = fitFrom(start);
  while (target >= start + fit && start < buildings.length - 1) {
    start++;
    ({ count: fit, used } = fitFrom(start));
  }

  const lots = [];
  const hits = [];    // worker rects in pixels, for mouse hit-testing
  const pending = []; // bubbles, drawn after every lot
  let x = margin + Math.floor((avail - used) / 2);
  for (let i = start; i < start + fit; i++) {
    const b = buildings[i];
    const w = widths[i];
    const bw = Math.min(w - 4, 22);
    const bx = x + Math.floor((w - bw) / 2);

    drawBuilding(cv, bx, groundY, bw, b, frame, sky);

    // Workers stand in front, spread across the lot.
    const n = b.workers.length;
    const totalW = WORKER_W + (n - 1) * WORKER_GAP;
    let wx = x + Math.floor((w - totalW) / 2);
    for (let k = 0; k < n; k++) {
      const worker = b.workers[k];
      const isSel = selected && selected.buildingIndex === i && selected.workerIndex === k;

      // Real text made bubbles ~10px tall instead of ~43px, so the ones that
      // matter all fit: anyone blocked, plus whoever you have selected.
      const wants = messageFor && (worker.state === 'blocked' || isSel);
      const text = wants ? messageFor(worker.paneId) : '';
      // The bubble's border already carries the agent colour, so a nameplate
      // under it is redundant and gets buried by neighbouring bubbles anyway.
      drawWorker(cv, wx, groundY + 2, worker, frame, isSel, !(isSel && text));
      // Sprite is 9x12 with its feet at groundY + 2.
      hits.push({
        x: wx, y: groundY + 2 - 12, w: WORKER_W, h: 12, paneId: worker.paneId,
      });

      if (text) {
        {
          pending.push({
            cx: wx + 4,
            worker,
            selected: isSel,
            title: worker.name,
            buildingTop: groundY - buildingHeight(b.floors, floorH(cv.h)),
            text,
          });
        }
      }
      wx += WORKER_GAP;
    }

    lots.push({ x, w, index: i, building: b });
    x += w;
  }

  // Bubbles last: they float above the whole scene, so nothing occludes them.
  const maxChars = bubbleChars(cv.w);
  const workerTop = groundY + 2 - 12; // worker sprite is 12px tall
  for (const p of pending) {
    p.lines = wrapPlain(p.text, maxChars, p.selected ? 4 : 3);
    // Sit above the roof rather than across it: with a single agent the
    // bubble would otherwise hide the very building the town is about.
    const { h } = measureBubble(p.lines, p.title);
    const aboveRoof = p.buildingTop - 3;
    p.bottomY = aboveRoof - h >= 1 ? aboveRoof : workerTop - 3;
    p.workerTop = workerTop;
  }
  const laid = layoutBubbles(cv, pending.slice(0, 4));
  // Draw the selected one last so it wins any residual overlap.
  laid.sort((a, b) => Number(a.selected) - Number(b.selected));
  for (const p of laid) {
    const blocked = p.worker.state === 'blocked';
    drawSpeechBubble(cv, p.cx, p.box, p.lines, {
      fill: blocked ? P.white : mix(P.white, P.navy, 0.12),
      textColor: P.black,
      border: blocked ? P.red : agentColor(p.worker.name),
      title: p.title,
      // Only draw a leader when the bubble cleared the building.
      pointToY: p.box.y + p.box.h + 4 < p.buildingTop ? p.buildingTop : undefined,
    });
  }

  return { lots, hits, scroll: start };
}

// --------------------------------------------------------------- world view

// The overview: every project as its own small town, each on its own plot so
// the skylines read as separate places rather than one continuous city.
const MINI_GAP = 2;
const PLOT_PAD = 2;
const MINI_MAX = 5; // silhouettes per town before we show an overflow marker

// Pick how many buildings to show and how wide to draw them, so a plot with
// two buildings uses chunky ones and a busy plot packs in more.
function miniLayout(plotW, count) {
  const inner = plotW - PLOT_PAD * 2;
  for (let n = Math.min(MINI_MAX, count); n >= 1; n--) {
    const bw = Math.floor((inner - (n - 1) * MINI_GAP) / n);
    if (bw >= 4) return { n, bw: Math.min(bw, 9) };
  }
  return { n: 1, bw: Math.max(3, inner) };
}

function drawWorld(cv, towns, opts) {
  const { frame, selectedTown } = opts;
  const groundY = groundLine(cv.h);
  const sky = opts.sky || daylight.current();

  drawSky(cv, groundY, frame, sky);
  drawHills(cv, groundY, sky);
  drawGround(cv, groundY, sky);

  if (towns.length === 0) return { slots: [] };

  const slotW = Math.floor(cv.w / towns.length);
  const slots = [];

  for (let i = 0; i < towns.length; i++) {
    const town = towns[i];
    const x0 = i * slotW;
    const isSel = i === selectedTown;

    // Leave a gap between plots so towns are visually distinct.
    const plotX = x0 + 2;
    const plotW = slotW - 4;
    const state = town.counts.blocked > 0 ? 'blocked'
      : town.counts.working > 0 ? 'working'
        : town.agentCount > 0 ? 'idle' : 'unknown';
    const accent = STATE_COLOR[state];

    // Raised plot of land.
    const plotTop = groundY - 1;
    cv.rect(plotX, plotTop, plotW, 3, mix(P.green, P.black, isSel ? 0.15 : 0.45));
    cv.hline(plotX, plotTop, plotW, isSel ? P.lime : mix(P.green, P.black, 0.3));
    // Edge posts mark the plot boundary and carry the town's headline state.
    cv.vline(plotX, plotTop - 4, 5, accent);
    cv.vline(plotX + plotW - 1, plotTop - 4, 5, accent);
    cv.set(plotX, plotTop - 5, mix(accent, P.white, 0.4));
    cv.set(plotX + plotW - 1, plotTop - 5, mix(accent, P.white, 0.4));

    const source = town.buildingList.length
      ? town.buildingList
      : [{ key: town.id, state: 'unknown', floors: 1 }];
    const { n, bw } = miniLayout(plotW, source.length);
    const list = source.slice(0, n);

    const total = list.length * (bw + MINI_GAP) - MINI_GAP;
    let bx = plotX + Math.max(PLOT_PAD, Math.floor((plotW - total) / 2));
    let tallestTop = groundY;

    for (const b of list) {
      const floors = Math.min(4, b.floors);
      const h = floors * 4 + 2;
      const top = plotTop - h;
      if (top < tallestTop) tallestTop = top;
      const bAccent = STATE_COLOR[b.state] || P.slate;
      cv.rect(bx, top, bw, h, mix(P.slate, P.black, 0.3));
      cv.vline(bx + bw - 1, top, h, mix(P.slate, P.black, 0.5));
      cv.hline(bx, top - 1, bw, bAccent);
      const winCols = Math.max(1, Math.floor((bw - 1) / 3));
      for (let f = 0; f < floors; f++) {
        const wy = plotTop - 2 - (f + 1) * 4 + 1;
        const lit = b.state === 'working'
          ? (Math.floor(frame / 5) + f) % 3 !== 0
          : b.state === 'done' || (b.state === 'blocked' && f % 2 === 0);
        const color = lit
          ? (b.state === 'blocked' ? P.red : b.state === 'done' ? P.cyan : P.yellow)
          : mix(P.black, P.navy, 0.5);
        for (let c = 0; c < winCols; c++) {
          const wx = bx + 1 + c * 3;
          if (wx + 1 >= bx + bw - 1) break;
          cv.rect(wx, wy, 2, 2, color);
        }
      }
      bx += bw + MINI_GAP;
    }

    // One pulsing "!" per town that needs attention, above its skyline.
    if (town.counts.blocked > 0 && Math.floor(frame / 8) % 4 !== 3) {
      cv.blit(bubbleBang, plotX + Math.floor(plotW / 2) - 2, Math.max(0, tallestTop - 9));
    }

    // Overflow marker: this town has more buildings than the plot can show.
    if (source.length > list.length) {
      const dy = plotTop - 4;
      for (let d = 0; d < 3; d++) cv.set(plotX + plotW - 4 + d, dy, P.grey);
    }

    if (isSel) {
      // A soft frame around the selected plot, rather than a heavy white bar.
      const top = Math.max(0, tallestTop - 3);
      cv.hline(plotX, top, plotW, mix(P.white, P.black, 0.45));
      cv.vline(plotX, top, plotTop - top, mix(P.white, P.black, 0.55));
      cv.vline(plotX + plotW - 1, top, plotTop - top, mix(P.white, P.black, 0.55));
    }

    slots.push({ x: x0, w: slotW, town, index: i });
  }

  return { slots };
}

module.exports = { drawTown, drawWorld, STATE_COLOR };
