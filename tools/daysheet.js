'use strict';

// Dev tool: render the same town at every hour of the day into one contact
// sheet, so the whole cycle can be judged at a glance.
//
//   node tools/daysheet.js out.png [scale]

const { Canvas } = require('../src/canvas');
const { P } = require('../src/palette');
const { drawTown } = require('../src/scene');
const { drawText } = require('../src/font');
const daylight = require('../src/daylight');
const { writePng, blitCanvas } = require('./png');

const HOURS = [2, 5.5, 6.5, 8, 11, 13, 16, 18.5, 19.75, 21, 22.5, 0];

const COLS = 100;
const ROWS = 22; // canvas rows per tile
const GRID_COLS = 3;
const GAP = 3;

function town() {
  const mk = (label, state, floors, workers) => ({
    key: label,
    label,
    state,
    floors,
    workMs: floors * 60 * 60000,
    workers: workers.map((w, i) => ({
      paneId: `w1:p${label.length}${i}`, name: w.name, state: w.state, focused: false, title: label,
    })),
  });
  return {
    id: 'w1',
    label: 'Klinika',
    number: 1,
    focused: true,
    counts: {
      working: 2, blocked: 1, idle: 1, done: 0, unknown: 0,
    },
    agentCount: 4,
    buildingList: [
      mk('QR kod hatasi', 'blocked', 3, [{ name: 'claude', state: 'blocked' }]),
      mk('voice agent', 'working', 6, [{ name: 'claude', state: 'working' }]),
      mk('landing page', 'working', 2, [{ name: 'cursor', state: 'working' }]),
      mk('docs pass', 'idle', 1, [{ name: 'gemini', state: 'idle' }]),
      mk('auth refactor', 'complete', 8, []),
      mk('billing v1', 'complete', 5, []),
      mk('old migration', 'ruin', 4, []),
    ],
  };
}

const [, , outFile = 'daysheet.png', scaleArg = '3'] = process.argv;
const scale = Number(scaleArg);

const tileW = COLS * scale;
const tileH = ROWS * 2 * scale;
const gridRows = Math.ceil(HOURS.length / GRID_COLS);
const W = GRID_COLS * tileW + (GRID_COLS - 1) * GAP;
const H = gridRows * tileH + (gridRows - 1) * GAP;

const rgb = Buffer.alloc(W * H * 3, 0x11);

HOURS.forEach((h, i) => {
  const sky = daylight.skyAt(h);
  const cv = new Canvas(COLS, ROWS * 2, P.black);
  drawTown(cv, town(), {
    frame: Math.floor(h * 7), // vary the animation phase per tile
    scroll: 0,
    selected: null,
    sky,
  });

  // Label each tile in the pixel font, top-left, over its own sky.
  const hh = String(Math.floor(h)).padStart(2, '0');
  const mm = String(Math.round((h % 1) * 60)).padStart(2, '0');
  drawText(cv, 3, 2, `${hh}:${mm} ${sky.label}`, P.white);

  const gx = i % GRID_COLS;
  const gy = Math.floor(i / GRID_COLS);
  blitCanvas(cv, rgb, W, gx * (tileW + GAP), gy * (tileH + GAP), scale);
});

writePng(outFile, W, H, rgb);
process.stdout.write(`wrote ${outFile} (${W}x${H}) — ${HOURS.length} hours\n`);
