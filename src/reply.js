'use strict';

const MAX_REPLY = 64000;

function cleanText(text) {
  return String(text)
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, '') // OSC, including clipboard commands
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\r\n?/g, '\n')
    .replace(/\t/g, '  ')
    .replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, '');
}

// In-memory, per-pane drafts. A pinned identity prevents a refreshed selection
// from redirecting text. The editor's cursor uses code points, not UTF-16 units.
class ReplyDrafts {
  constructor() {
    this.drafts = new Map();
    this.target = null;
    this.text = '';
    this.cursor = 0;
    this.confirming = false;
    this.sending = false;
    this.error = '';
  }

  open(target) {
    this.target = { ...target };
    const draft = this.drafts.get(target.paneId);
    // A different agent CLI in a reused pane must not inherit the old draft.
    this.text = draft && draft.name === target.name && draft.townId === target.townId ? draft.text : '';
    this.cursor = [...this.text].length;
    this.confirming = false;
    this.error = '';
  }

  save() {
    if (!this.target) return;
    if (this.text) this.drafts.set(this.target.paneId, { name: this.target.name, townId: this.target.townId, text: this.text });
    else this.drafts.delete(this.target.paneId);
  }

  insert(text) {
    if (this.sending || this.confirming) return;
    const chars = [...this.text];
    const added = [...cleanText(text)];
    const room = MAX_REPLY - chars.length;
    chars.splice(this.cursor, 0, ...added.slice(0, room));
    this.cursor += Math.min(room, added.length);
    this.text = chars.join('');
    this.error = added.length > room ? `Draft limited to ${MAX_REPLY} characters; paste truncated.` : '';
    this.save();
  }

  key(key) {
    if (this.sending || this.confirming) return;
    const chars = [...this.text];
    const start = this.cursor > 0 ? chars.lastIndexOf('\n', this.cursor - 1) + 1 : 0;
    const foundEnd = chars.indexOf('\n', this.cursor);
    const end = foundEnd < 0 ? chars.length : foundEnd;
    if (key === '\x1b[D' || key === '\x1bOD') this.cursor = Math.max(0, this.cursor - 1);
    else if (key === '\x1b[C' || key === '\x1bOC') this.cursor = Math.min(chars.length, this.cursor + 1);
    else if (key === '\x01' || key === '\x1b[H' || key === '\x1bOH' || key === '\x1b[1~') this.cursor = start;
    else if (key === '\x05' || key === '\x1b[F' || key === '\x1bOF' || key === '\x1b[4~') this.cursor = end;
    else if (key === '\x1b[A' || key === '\x1bOA') {
      if (start > 0) {
        const prevStart = start > 1 ? chars.lastIndexOf('\n', start - 2) + 1 : 0;
        this.cursor = Math.min(start - 1, prevStart + this.cursor - start);
      }
    } else if (key === '\x1b[B' || key === '\x1bOB') {
      if (end < chars.length) {
        const nextEnd = chars.indexOf('\n', end + 1);
        this.cursor = Math.min(nextEnd < 0 ? chars.length : nextEnd, end + 1 + this.cursor - start);
      }
    } else if (key === '\x7f' || key === '\b') {
      if (this.cursor > 0) chars.splice(--this.cursor, 1);
      this.text = chars.join('');
    } else if (key === '\x1b[3~') {
      chars.splice(this.cursor, 1);
      this.text = chars.join('');
    } else if (key === '\x15') {
      this.text = '';
      this.cursor = 0;
    } else if (key === '\r' || key === '\n') this.insert('\n');
    else if (!key.startsWith('\x1b')) this.insert(key);
    this.save();
  }
}

module.exports = { ReplyDrafts, cleanText, MAX_REPLY };
