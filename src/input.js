'use strict';

const { StringDecoder } = require('node:string_decoder');
const { MAX_REPLY } = require('./reply');
const mouse = require('./mouse');

const ENABLE = '\x1b[?2004h\x1b[?1004h';
const DISABLE = '\x1b[?2004l\x1b[?1004l';
const PASTE_START = '\x1b[200~';
const PASTE_END = '\x1b[201~';

// Frame paste BEFORE parsing keys or mouse reports. Neither a newline nor an
// escape sequence in pasted text can execute an application action. Keep an
// incomplete escape/paste delimiter across input chunks, including UTF-8 splits.
class TerminalInput {
  constructor(emit) {
    this.emit = emit;
    this.decoder = new StringDecoder('utf8');
    this.pending = '';
    this.pasting = false;
    this.paste = '';
    this.truncated = false;
  }

  addPaste(text) {
    const room = MAX_REPLY - this.paste.length;
    this.paste += text.slice(0, room);
    if (text.length > room) this.truncated = true;
  }

  feed(data) {
    this.pending += Buffer.isBuffer(data) ? this.decoder.write(data) : data;
    while (this.pending) {
      if (this.pasting) {
        const end = this.pending.indexOf(PASTE_END);
        if (end < 0) {
          // Retain enough bytes to recognize a delimiter split across chunks.
          const take = Math.max(0, this.pending.length - PASTE_END.length + 1);
          this.addPaste(this.pending.slice(0, take));
          this.pending = this.pending.slice(take);
          return;
        }
        this.addPaste(this.pending.slice(0, end));
        this.pending = this.pending.slice(end + PASTE_END.length);
        this.pasting = false;
        this.emit({ type: 'paste', text: this.paste, truncated: this.truncated });
        this.paste = '';
        this.truncated = false;
        continue;
      }
      if (this.pending.startsWith(PASTE_START)) {
        this.pending = this.pending.slice(PASTE_START.length);
        this.pasting = true;
        continue;
      }
      if (this.pending[0] === '\x1b') {
        if (this.pending.length === 1) return; // disambiguate bare Escape on timeout
        if (this.pending[1] === '[') {
          const match = /^\x1b\[[0-?]*[ -/]*[@-~]/.exec(this.pending);
          if (!match) {
            if (this.pending.length > 128) this.pending = ''; // malformed, bounded
            return;
          }
          const seq = match[0];
          this.pending = this.pending.slice(seq.length);
          if (/^\x1b\[<\d+;\d+;\d+[Mm]$/.test(seq)) {
            for (const event of mouse.parse(Buffer.from(seq)).events) this.emit({ type: 'mouse', event });
          } else if (seq === '\x1b[I' || seq === '\x1b[O') {
            this.emit({ type: 'focus', focused: seq === '\x1b[I' });
          } else if (seq !== PASTE_END) this.emit({ type: 'key', text: seq });
          continue;
        }
        if (this.pending[1] === 'O') {
          if (this.pending.length < 3) return;
          this.emit({ type: 'key', text: this.pending.slice(0, 3) });
          this.pending = this.pending.slice(3);
          continue;
        }
        // Ignore an unsupported Alt-key chord rather than turning it into
        // Escape followed by a destructive town shortcut.
        this.pending = this.pending.slice(2);
        continue;
      }
      // Batch printable text so an unbracketed large paste is not quadratic
      // in the editor. Control keys remain individual events.
      const printable = /^[^\x00-\x1f\x7f-\x9f]+/.exec(this.pending);
      const text = printable ? printable[0] : String.fromCodePoint(this.pending.codePointAt(0));
      this.pending = this.pending.slice(text.length);
      this.emit({ type: 'key', text });
    }
  }

  flushEscape() {
    if (!this.pasting && this.pending === '\x1b') {
      this.pending = '';
      this.emit({ type: 'key', text: '\x1b' });
    }
  }
}

module.exports = { TerminalInput, ENABLE, DISABLE };
