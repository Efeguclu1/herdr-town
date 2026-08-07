'use strict';

// Dev tool: render a scene straight to a PNG so the pixel art can be inspected
// outside a terminal. Not part of the plugin runtime.
//
//   node tools/preview.js out.png [town|world] [scale] [frame]

const fs = require('node:fs');
const zlib = require('node:zlib');
const { Canvas } = require('../src/canvas');
const { P } = require('../src/palette');
const { drawTown, drawWorld } = require('../src/scene');

const { canvasToPng } = require('./png');

// A town covering every agent state at once.
function fakeTown() {
  const mk = (label, state, floors, workers) => ({
    key: label,
    label,
    state,
    floors,
    workMs: floors * 4 * 60000,
    workers: workers.map((w, i) => ({
      paneId: `w1:p${label.length}${i}`,
      name: w.name,
      state: w.state,
      focused: false,
      title: label,
    })),
  });
  return {
    id: 'w1',
    label: 'Klinika',
    number: 1,
    focused: true,
    counts: { working: 3, blocked: 1, idle: 1, done: 1, unknown: 0 },
    agentCount: 6,
    buildingList: [
      mk('QR kod hatasi', 'blocked', 3, [{ name: 'claude', state: 'blocked' }]),
      mk('voice agent', 'working', 5, [
        { name: 'claude', state: 'working' },
        { name: 'codex', state: 'working' },
      ]),
      mk('landing page', 'working', 2, [{ name: 'cursor', state: 'working' }]),
      mk('docs pass', 'idle', 1, [{ name: 'gemini', state: 'idle' }]),
      // Standing buildings: no agents, drawn from the store.
      mk('auth refactor', 'complete', 8, []),
      mk('billing v1', 'complete', 5, []),
      mk('old migration', 'ruin', 4, []),
    ],
  };
}

function fakeWorld() {
  const t = fakeTown();
  return [
    t,
    { ...t, id: 'w2', label: 'fablo', counts: { working: 1, blocked: 0, idle: 2, done: 0, unknown: 0 }, agentCount: 3, buildingList: t.buildingList.slice(1, 4) },
    { ...t, id: 'w3', label: 'herdr plugins', counts: { working: 1, blocked: 0, idle: 0, done: 0, unknown: 0 }, agentCount: 1, buildingList: t.buildingList.slice(1, 2) },
    { ...t, id: 'w4', label: 'quiet', counts: { working: 0, blocked: 0, idle: 1, done: 0, unknown: 0 }, agentCount: 1, buildingList: t.buildingList.slice(4) },
  ];
}

const [, , outFile = 'preview.png', mode = 'town', scaleArg = '5', frameArg = '0', hourArg] = process.argv;
if (hourArg !== undefined) process.env.HERDR_TOWN_HOUR = hourArg;
const scale = Number(scaleArg);
const frame = Number(frameArg);

const cols = Number(process.env.PREVIEW_COLS || 161);
const rows = Number(process.env.PREVIEW_ROWS || 52);
const cv = new Canvas(cols, rows * 2, P.black);

if (mode === 'solo') {
  const t = fakeTown();
  const one = t.buildingList[1];
  one.workers = [one.workers[0]];
  drawTown(cv, { ...t, buildingList: [one] }, {
    frame,
    scroll: 0,
    selected: { buildingIndex: 0, workerIndex: 0 },
    messageFor: () => 'I found two ways to fix the QR handshake. Patch the client, or bump the library to 3.2 and drop the shim?',
  });
} else if (mode === 'world') {
  drawWorld(cv, fakeWorld(), { frame, selectedTown: 0 });
} else {
  const msgs = {
    'w1:p130': 'Should I patch the client or bump the library?',
    'w1:p110': 'Which thread do you want to pull first?',
  };
  drawTown(cv, fakeTown(), {
    frame,
    scroll: 0,
    selected: { buildingIndex: 1, workerIndex: 0 },
    messageFor: (id) => msgs[id] || '',
  });
}

canvasToPng(cv, outFile, scale);
process.stdout.write(`wrote ${outFile} (${cv.w * scale}x${cv.h * scale})\n`);
