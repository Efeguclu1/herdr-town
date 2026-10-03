'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const { STATE_DIR } = require('./store');

const MAX_EVENTS = 1000;
const RETENTION_MS = 7 * 24 * 3600 * 1000;

function validActivity(value) {
  return value && typeof value.epoch === 'string' && Number.isInteger(value.seq)
    && value.seq >= 0 && Number.isFinite(value.at) && Array.isArray(value.events)
    && value.events.every((e) => e && Number.isInteger(e.id) && Number.isFinite(e.at))
    && value.workers && typeof value.workers === 'object'
    && value.buildings && typeof value.buildings === 'object';
}

// Called only by the recorder. Persist both the baseline and events so a
// recorder restart doesn't replay every live worker as a newly started agent.
function recordActivity(previous, world, now = Date.now()) {
  if (!validActivity(previous)) previous = null;
  const workers = Object.create(null);
  const buildings = Object.create(null);
  for (const town of world.towns) {
    for (const b of town.buildingList) {
      if (b.standing) continue;
      const feature = { townId: town.id, town: town.label, key: b.key, task: b.label, state: b.state };
      buildings[b.key] = feature;
      for (const w of b.workers) {
        workers[w.paneId] = { ...feature, paneId: w.paneId, name: w.name, state: w.state };
      }
    }
  }
  const current = {
    epoch: previous ? previous.epoch : randomBytes(12).toString('hex'),
    seq: previous ? previous.seq : 0,
    startedAt: previous ? previous.startedAt : now,
    at: now, workers, buildings, events: previous ? [...previous.events] : [],
  };
  function emit(type, item) {
    current.events.push({ ...item, type, id: ++current.seq, at: now });
  }
  if (previous) {
    if (now - previous.at > 60000) emit('gap', { since: previous.at });
    for (const [id, w] of Object.entries(workers)) {
      const old = previous.workers[id];
      const same = old && old.name === w.name && old.key === w.key;
      if (!same) emit('started', w);
      if (w.state === 'blocked' && (!same || old.state !== 'blocked')) emit('blocked', w);
      else if (same && old.state === 'blocked' && w.state !== 'blocked') emit('unblocked', w);
      else if (same && old.state !== w.state) emit('state', { ...w, from: old.state });
    }
    for (const [key, b] of Object.entries(buildings)) {
      if (b.state === 'done' && (!previous.buildings[key] || previous.buildings[key].state !== 'done')) emit('finished', b);
    }
    for (const [id, w] of Object.entries(previous.workers)) {
      if (!workers[id] || workers[id].key !== w.key || workers[id].name !== w.name) emit('left', w);
    }
  }
  current.events = current.events.filter((e) => e.at >= now - RETENTION_MS).slice(-MAX_EVENTS);
  return current;
}

// UI-owned acknowledgement is deliberately separate from recorder-owned
// progress.json. Draft message text is never written to either file.
class SummaryCursor {
  constructor(file = path.join(STATE_DIR, 'summary-seen.json')) {
    this.file = file;
    this.value = null;
    this.load();
  }

  load() {
    if (!this.file) return;
    try {
      const value = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (typeof value.epoch === 'string' && Number.isInteger(value.seq) && value.seq >= 0) this.value = value;
    } catch { /* First run, or invalid state: show retained events again. */ }
  }

  acknowledge(epoch, seq) {
    this.load();
    const value = { epoch, seq: this.value && this.value.epoch === epoch ? Math.max(this.value.seq, seq) : seq };
    if (this.file) {
      const tmp = `${this.file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
      try {
        fs.mkdirSync(path.dirname(this.file), { recursive: true });
        fs.writeFileSync(tmp, JSON.stringify(value), { mode: 0o600 });
        fs.renameSync(tmp, this.file);
      } catch (e) {
        try { fs.unlinkSync(tmp); } catch { /* Nothing to clean up. */ }
        throw e;
      }
    }
    this.value = value;
  }
}

function summarySince(activity, cursor) {
  if (!validActivity(activity)) return { events: [], through: 0, unavailable: true };
  const since = cursor && cursor.epoch === activity.epoch ? cursor.seq : 0;
  const events = activity.events.filter((e) => e.id > since);
  const first = activity.events.length ? activity.events[0].id : activity.seq + 1;
  return {
    epoch: activity.epoch, through: activity.seq, events,
    lastRecorded: activity.at, startedAt: activity.startedAt,
    truncated: since < first - 1,
  };
}

module.exports = { recordActivity, SummaryCursor, summarySince, MAX_EVENTS, RETENTION_MS };
