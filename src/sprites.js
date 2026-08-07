'use strict';

const { P } = require('./palette');

// Sprites are written as ASCII art and compiled once at load. '.' is
// transparent; every other character is a legend key resolved through
// `colors`, or overridden per-draw (see Canvas#blit).
function sprite(rows, colors) {
  const h = rows.length;
  const w = rows[0].length;
  for (const r of rows) {
    if (r.length !== w) throw new Error(`ragged sprite row: "${r}" (expected width ${w})`);
  }
  return { w, h, keys: rows.join(''), colors };
}

// Worker legend:
//   A agent colour (helmet + shirt)   S skin        e eye
//   P trousers                        B boot
//   T tool head                       t tool handle
const WORKER = {
  A: P.orange, // replaced per agent at draw time
  S: P.yellow,
  e: P.black,
  P: P.navy,
  B: P.dark,
  T: P.grey,
  t: P.slate,
};

// All worker poses share a 9x12 frame so they can be swapped without shifting
// the character's feet.
const workerIdle = sprite([
  '.........',
  '.........',
  '..AAAAA..',
  '.AAAAAAA.',
  '..SSSSS..',
  '..SeSeS..',
  '...SSS...',
  '..AAAAA..',
  '.SAAAAAS.',
  '..AAAAA..',
  '..PP.PP..',
  '..BB.BB..',
], WORKER);

// Hammer raised. Alternating with workerStrike gives the "building" animation.
const workerRaise = sprite([
  '.......TT',
  '.......tT',
  '..AAAAAt.',
  '.AAAAAAA.',
  '..SSSSS..',
  '..SeSeS..',
  '...SSS...',
  '..AAAAAS.',
  '.SAAAAA..',
  '..AAAAA..',
  '..PP.PP..',
  '..BB.BB..',
], WORKER);

// Hammer down, mid-strike.
const workerStrike = sprite([
  '.........',
  '.........',
  '..AAAAA..',
  '.AAAAAAA.',
  '..SSSSS..',
  '..SeSeS..',
  '...SSS...',
  '..AAAAAS.',
  '.SAAAAAt.',
  '..AAAAAtT',
  '..PP.PPTT',
  '..BB.BB..',
], WORKER);

// Arms up: used for both "blocked" (with a ! bubble) and "done" (with confetti).
const workerArmsUp = sprite([
  '.........',
  '.S.....S.',
  '.SAAAAAS.',
  '.AAAAAAA.',
  '..SSSSS..',
  '..SeSeS..',
  '...SSS...',
  '..AAAAA..',
  '..AAAAA..',
  '..AAAAA..',
  '..PP.PP..',
  '..BB.BB..',
], WORKER);

// Eyes closed, shoulders dropped: idle/asleep.
const workerSleep = sprite([
  '.........',
  '.........',
  '..AAAAA..',
  '.AAAAAAA.',
  '..SSSSS..',
  '..SeeeS..',
  '...SSS...',
  '..AAAAA..',
  '.SAAAAAS.',
  '..AAAAA..',
  '..PP.PP..',
  '..BB.BB..',
], WORKER);

// A "!" speech bubble that floats over blocked workers.
const bubbleBang = sprite([
  '.WWW.',
  'WWWWW',
  'WWrWW',
  'WWrWW',
  'WWWWW',
  'WWrWW',
  '.WW..',
], { W: P.white, r: P.red });

// Floating "z" for sleeping workers.
const zzz = sprite([
  'zzzz',
  '..z.',
  '.z..',
  'zzzz',
], { z: P.cyan });

// Little tree to fill out the town's empty lots.
const tree = sprite([
  '..ggg..',
  '.ggggg.',
  'ggggggg',
  '.ggggg.',
  '..ggg..',
  '...t...',
  '...t...',
], { g: P.green, t: P.dark });

const WORKER_POSES = {
  idle: workerIdle,
  sleep: workerSleep,
  raise: workerRaise,
  strike: workerStrike,
  armsUp: workerArmsUp,
};

module.exports = { sprite, WORKER_POSES, bubbleBang, zzz, tree };
