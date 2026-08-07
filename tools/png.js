'use strict';

// Minimal PNG writer shared by the dev preview tools. Not part of the plugin
// runtime; it exists so scenes can be inspected outside a terminal.

const fs = require('node:fs');
const zlib = require('node:zlib');
const { glyphFor, GLYPH_W, GLYPH_H } = require('../src/font');

function crc32(buf) {
  const table = crc32.table || (crc32.table = (() => {
    const t = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c;
    }
    return t;
  })());
  let crc = -1;
  for (let i = 0; i < buf.length; i++) crc = (crc >>> 8) ^ table[(crc ^ buf[i]) & 0xff];
  return (crc ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

function writePng(file, w, h, rgb) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // truecolour
  const raw = Buffer.alloc(h * (w * 3 + 1));
  let o = 0;
  for (let y = 0; y < h; y++) {
    raw[o++] = 0;
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 3;
      raw[o++] = rgb[i];
      raw[o++] = rgb[i + 1];
      raw[o++] = rgb[i + 2];
    }
  }
  fs.writeFileSync(file, Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]));
}

function put(rgb, bufW, x, y, c) {
  const i = (y * bufW + x) * 3;
  rgb[i] = (c >> 16) & 255;
  rgb[i + 1] = (c >> 8) & 255;
  rgb[i + 2] = c & 255;
}

// Blit a Canvas into an RGB buffer at (ox, oy), scaled up.
//
// Text cells hold real characters that the terminal draws in its own font. A
// PNG has no font, so they are approximated with the bundled 3x5 glyphs:
// close enough that a screenshot shows what a bubble actually says instead of
// an empty box.
function blitCanvas(cv, rgb, bufW, ox, oy, scale) {
  for (let y = 0; y < cv.h * scale; y++) {
    for (let x = 0; x < cv.w * scale; x++) {
      const px = cv.px[Math.floor(y / scale) * cv.w + Math.floor(x / scale)];
      const c = px < 0 ? cv.bg : px;
      put(rgb, bufW, ox + x, oy + y, c);
    }
  }

  if (!cv.textCells || cv.textCells.size === 0) return;
  const gs = Math.max(1, Math.floor(scale / GLYPH_W));
  for (const [key, cell] of cv.textCells) {
    const col = key % cv.w;
    const cellRow = Math.floor(key / cv.w);
    const cx = ox + col * scale;
    const cy = oy + cellRow * 2 * scale;
    const bg = cell.bg === undefined || cell.bg === null ? cv.bg : cell.bg;

    for (let y = 0; y < 2 * scale; y++) {
      for (let x = 0; x < scale; x++) put(rgb, bufW, cx + x, cy + y, bg);
    }

    const rows = glyphFor(cell.ch);
    const gw = GLYPH_W * gs;
    const gh = GLYPH_H * gs;
    const offX = Math.floor((scale - gw) / 2);
    const offY = Math.floor((2 * scale - gh) / 2);
    for (let j = 0; j < GLYPH_H; j++) {
      for (let i = 0; i < GLYPH_W; i++) {
        if (rows[j][i] !== '#') continue;
        for (let sy = 0; sy < gs; sy++) {
          for (let sx = 0; sx < gs; sx++) {
            const px = cx + offX + i * gs + sx;
            const py = cy + offY + j * gs + sy;
            if (px >= ox && px < ox + cv.w * scale && py >= oy && py < oy + cv.h * scale) {
              put(rgb, bufW, px, py, cell.fg);
            }
          }
        }
      }
    }
  }
}

function canvasToPng(cv, file, scale) {
  const W = cv.w * scale;
  const H = cv.h * scale;
  const rgb = Buffer.alloc(W * H * 3);
  blitCanvas(cv, rgb, W, 0, 0, scale);
  writePng(file, W, H, rgb);
}

module.exports = { writePng, canvasToPng, blitCanvas };
