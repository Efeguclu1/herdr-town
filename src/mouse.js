'use strict';

// Mouse input for the town. The probe in tools/mouse-probe.js established that
// Herdr forwards mouse reports to a plugin pane, including motion, so the town
// can be browsed by moving the pointer rather than only by arrow keys.
//
// 1000 = clicks, 1002 = motion while a button is held, 1003 = all motion
// (needed for hover), 1006 = SGR coordinates so columns past 223 work.
const MODES = ['1000', '1002', '1003', '1006'];

const ENABLE = MODES.map((m) => `\x1b[?${m}h`).join('');
const DISABLE = MODES.slice().reverse().map((m) => `\x1b[?${m}l`).join('');

// Pull complete mouse sequences out of a chunk, returning the leftover bytes
// so key handling still sees ordinary input.
function parse(buf) {
  const events = [];
  const rest = [];
  let i = 0;
  while (i < buf.length) {
    if (buf[i] === 0x1b && buf[i + 1] === 0x5b && buf[i + 2] === 0x3c) {
      let j = i + 3;
      while (j < buf.length && buf[j] !== 0x4d && buf[j] !== 0x6d) j++;
      if (j < buf.length) {
        const m = /^\x1b\[<(\d+);(\d+);(\d+)([Mm])$/.exec(buf.slice(i, j + 1).toString('latin1'));
        if (m) {
          const btn = Number(m[1]);
          const base = btn & 3;
          const wheel = (btn & 64) !== 0;
          const motion = (btn & 32) !== 0;
          events.push({
            name: wheel ? (base === 0 ? 'wheel-up' : 'wheel-down')
              : motion ? 'motion'
                : ['left', 'middle', 'right', 'release'][base],
            press: m[4] === 'M',
            col: Number(m[2]),
            row: Number(m[3]),
            ctrl: (btn & 16) !== 0,
            shift: (btn & 4) !== 0,
          });
        }
        i = j + 1;
        continue;
      }
    }
    rest.push(buf[i]);
    i++;
  }
  return { events, rest: Buffer.from(rest) };
}

module.exports = { ENABLE, DISABLE, parse };
