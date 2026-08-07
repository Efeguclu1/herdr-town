'use strict';

// A pixel canvas that renders into a terminal at 2 vertical pixels per cell.
//
// Each cell is drawn as U+2580 UPPER HALF BLOCK: the foreground colour paints
// the top pixel, the background colour paints the bottom one. So a terminal of
// C columns x R rows is a C x 2R pixel display, with roughly square pixels
// (terminal cells are about twice as tall as they are wide).
class Canvas {
  constructor(w, h, bg) {
    this.w = w;
    this.h = h % 2 === 0 ? h : h - 1;
    this.bg = bg;
    this.px = new Int32Array(this.w * this.h).fill(-1); // -1 = transparent
    // Cells that carry a real character instead of two pixels. A canvas column
    // is exactly one terminal column, so text can be composited into the scene
    // at full font resolution: far more readable than the 3x5 pixel font, and
    // one line costs 2 pixel rows instead of 7.
    this.textCells = new Map();
  }

  clear() {
    this.px.fill(-1);
    this.textCells.clear();
  }

  // Place real text at a cell row (cellRow = pixel row / 2).
  text(col, cellRow, str, fgColor, bgColor) {
    const rows = this.h / 2;
    if (cellRow < 0 || cellRow >= rows) return;
    const chars = [...String(str)];
    for (let i = 0; i < chars.length; i++) {
      const c = col + i;
      if (c < 0 || c >= this.w) continue;
      this.textCells.set(cellRow * this.w + c, { ch: chars[i], fg: fgColor, bg: bgColor });
    }
  }

  set(x, y, color) {
    if (color === undefined || color === null || color < 0) return;
    const ix = x | 0, iy = y | 0;
    if (ix < 0 || iy < 0 || ix >= this.w || iy >= this.h) return;
    this.px[iy * this.w + ix] = color;
  }

  rect(x, y, w, h, color) {
    for (let j = 0; j < h; j++) {
      for (let i = 0; i < w; i++) this.set(x + i, y + j, color);
    }
  }

  hline(x, y, len, color) {
    for (let i = 0; i < len; i++) this.set(x + i, y, color);
  }

  vline(x, y, len, color) {
    for (let j = 0; j < len; j++) this.set(x, y + j, color);
  }

  // Draw a sprite (see sprites.js). `overrides` remaps legend keys to colours
  // at draw time, which is how one worker sprite renders in each agent's colour.
  blit(sprite, x, y, overrides) {
    const { w, h, keys, colors } = sprite;
    for (let j = 0; j < h; j++) {
      for (let i = 0; i < w; i++) {
        const idx = j * w + i;
        const key = keys[idx];
        if (key === '.') continue;
        let color = colors[key];
        if (overrides && Object.prototype.hasOwnProperty.call(overrides, key)) {
          color = overrides[key];
        }
        if (color === undefined || color === null) continue;
        this.set(x + i, y + j, color);
      }
    }
  }

  // Emit one string per terminal row, with colour changes coalesced so we only
  // pay for an escape sequence when a colour actually changes.
  render() {
    const lines = [];
    const bg = this.bg;
    for (let r = 0; r < this.h / 2; r++) {
      let out = '';
      let curFg = -1;
      let curBg = -1;
      const topRow = 2 * r * this.w;
      const botRow = (2 * r + 1) * this.w;
      for (let x = 0; x < this.w; x++) {
        const cell = this.textCells.get(r * this.w + x);
        let fg;
        let bc;
        let ch;
        if (cell) {
          fg = cell.fg;
          bc = cell.bg === undefined || cell.bg === null ? bg : cell.bg;
          ch = cell.ch;
        } else {
          const t = this.px[topRow + x];
          const b = this.px[botRow + x];
          fg = t < 0 ? bg : t;
          bc = b < 0 ? bg : b;
          ch = '▀';
        }
        if (fg !== curFg) {
          out += `\x1b[38;2;${(fg >> 16) & 255};${(fg >> 8) & 255};${fg & 255}m`;
          curFg = fg;
        }
        if (bc !== curBg) {
          out += `\x1b[48;2;${(bc >> 16) & 255};${(bc >> 8) & 255};${bc & 255}m`;
          curBg = bc;
        }
        out += ch;
      }
      lines.push(out + '\x1b[0m');
    }
    return lines;
  }
}

module.exports = { Canvas };
