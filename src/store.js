'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Buildings grow with the time agents actually spend working on them, so a
// town you come back to tomorrow is taller than the one you left. Herdr gives
// plugins a state directory for exactly this; there is no managed storage API.
//
// The fallback matters more than it looks. Herdr only sets
// HERDR_PLUGIN_STATE_DIR for processes it launches, so running the town or the
// recorder by hand used to land in a temp directory instead: a second store,
// a second lock file, and therefore a second recorder that could not see the
// first. Falling back to the same canonical path Herdr uses keeps manual runs
// and plugin runs on one store with one lock.
function defaultStateDir() {
  const id = 'efeguclu.town';
  if (process.platform === 'win32') {
    const base = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
    return path.join(base, 'herdr', 'plugins', id);
  }
  const base = process.env.XDG_STATE_HOME || path.join(os.homedir(), '.local', 'state');
  return path.join(base, 'herdr', 'plugins', id);
}

const STATE_DIR = process.env.HERDR_PLUGIN_STATE_DIR || defaultStateDir();
const FILE = path.join(STATE_DIR, 'progress.json');

const SAVE_EVERY_MS = 15000;

class Store {
  // The recorder owns writing; the view opens read-only and re-reads whatever
  // the recorder has written. One writer keeps the two from double-counting
  // the same working time.
  constructor({ readOnly = false } = {}) {
    this.data = { version: 1, features: {} };
    this.dirty = false;
    this.lastSave = 0;
    this.readOnly = readOnly;
    this.mtimeMs = 0;
    this.load();
  }

  load() {
    try {
      const raw = fs.readFileSync(FILE, 'utf8');
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && parsed.features) this.data = parsed;
      this.mtimeMs = fs.statSync(FILE).mtimeMs;
    } catch {
      // No state yet, or it is unreadable. Starting fresh is always safe here.
    }
  }

  // Pick up the recorder's writes without re-parsing on every frame.
  syncFromDisk() {
    try {
      const { mtimeMs } = fs.statSync(FILE);
      if (mtimeMs === this.mtimeMs) return false;
      this.load();
      return true;
    } catch {
      return false;
    }
  }

  save(force) {
    if (this.readOnly || !this.dirty) return;
    const now = Date.now();
    if (!force && now - this.lastSave < SAVE_EVERY_MS) return;
    try {
      fs.mkdirSync(STATE_DIR, { recursive: true });
      // Write-then-rename, so a reader never sees a half-written file.
      const tmp = `${FILE}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(this.data), 'utf8');
      fs.renameSync(tmp, FILE);
      this.dirty = false;
      this.lastSave = now;
      try { this.mtimeMs = fs.statSync(FILE).mtimeMs; } catch { /* best effort */ }
    } catch {
      // Losing progress is cosmetic; never take the view down over it.
    }
  }

  entry(key) {
    return this.data.features[key];
  }

  // Credit a feature with elapsed working time.
  addWork(key, ms) {
    if (!(ms > 0)) return;
    const f = this.data.features[key] || (this.data.features[key] = { ms: 0, seen: 0 });
    f.ms += ms;
    f.seen = Date.now();
    this.dirty = true;
  }

  // Remember what a feature is, so it can be drawn again after its agents are
  // gone. `done` latches: once a feature has been seen finished it stays a
  // finished building rather than decaying into a ruin.
  observe(key, { workspaceId, label, state }) {
    const f = this.data.features[key] || (this.data.features[key] = { ms: 0, seen: 0 });
    f.workspaceId = workspaceId;
    f.label = label;
    f.seen = Date.now();
    if (state === 'done') f.done = true;
    this.dirty = true;
  }

  workMs(key) {
    const f = this.data.features[key];
    return f ? f.ms : 0;
  }

  // Every remembered feature for a workspace, for rebuilding the skyline.
  featuresFor(workspaceId) {
    const out = [];
    for (const [key, v] of Object.entries(this.data.features)) {
      if (v.workspaceId === workspaceId && v.label) out.push({ key, ...v });
    }
    return out;
  }

  // Keep finished buildings around far longer than features that were merely
  // touched once, so a town's skyline is a record of what actually shipped.
  prune(maxAgeMs = 14 * 24 * 3600 * 1000, doneMaxAgeMs = 90 * 24 * 3600 * 1000) {
    const now = Date.now();
    for (const [k, v] of Object.entries(this.data.features)) {
      const limit = v.done ? doneMaxAgeMs : maxAgeMs;
      if ((v.seen || 0) < now - limit) {
        delete this.data.features[k];
        this.dirty = true;
      }
    }
  }
}

module.exports = { Store, STATE_DIR, FILE };
