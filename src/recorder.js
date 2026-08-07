'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { snapshot } = require('./herdr');
const { Store, STATE_DIR } = require('./store');
const { buildWorld, accrue, record } = require('./world');

// Buildings are supposed to grow with the time agents actually spend working.
// If that were only counted while the town view was open, a building would
// grow for the couple of minutes a day you happen to be looking at it. So the
// recorder runs in the background, started by the plugin's startup hook, and
// is the only thing that writes progress.

const LOCK = path.join(STATE_DIR, 'recorder.lock');
const POLL_MS = 15000;
const STALE_LOCK_MS = 90000;
const MAX_CONSECUTIVE_FAILURES = 20; // ~5 minutes; Herdr is probably gone

function readLock() {
  try {
    return JSON.parse(fs.readFileSync(LOCK, 'utf8'));
  } catch {
    return null;
  }
}

function alive(pid) {
  if (!pid || pid === process.pid) return false;
  try {
    process.kill(pid, 0); // signal 0 tests for existence only
    return true;
  } catch (e) {
    return e.code === 'EPERM'; // exists but owned by someone else
  }
}

// True when another recorder currently holds the lock and is still beating.
function locked() {
  const l = readLock();
  if (!l) return false;
  if (Date.now() - (l.beat || 0) > STALE_LOCK_MS) return false;
  return alive(l.pid);
}

function beat() {
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.writeFileSync(LOCK, JSON.stringify({ pid: process.pid, beat: Date.now() }), 'utf8');
  } catch { /* best effort */ }
}

function releaseLock() {
  const l = readLock();
  if (l && l.pid === process.pid) {
    try { fs.unlinkSync(LOCK); } catch { /* already gone */ }
  }
}

async function runRecorder({ log = () => {} } = {}) {
  if (locked()) {
    log('another recorder is already running');
    return 0;
  }
  beat();

  const store = new Store();
  let prevAt = 0;
  let failures = 0;
  let ticks = 0;
  let stopping = false;

  const stop = () => {
    stopping = true;
    store.save(true);
    releaseLock();
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  process.on('SIGHUP', stop);
  process.on('exit', () => { store.save(true); releaseLock(); });

  log(`recording to ${STATE_DIR} every ${POLL_MS / 1000}s (pid ${process.pid})`);

  while (!stopping) {
    try {
      const snap = await snapshot();
      const world = buildWorld(snap, store);
      if (prevAt) accrue(world, store, snap.at - prevAt);
      record(world, store);
      prevAt = snap.at;
      failures = 0;
    } catch (e) {
      failures++;
      if (failures >= MAX_CONSECUTIVE_FAILURES) {
        log(`giving up after ${failures} failures: ${e.message}`);
        break;
      }
      // Herdr may be restarting; treat the gap as lost rather than credited.
      prevAt = 0;
    }

    // Another recorder took the lock (e.g. after a live handoff) — stand down.
    const l = readLock();
    if (l && l.pid !== process.pid && alive(l.pid)) {
      log('another recorder took over');
      break;
    }
    beat();

    store.save(false);
    if (++ticks % 240 === 0) store.prune(); // roughly hourly

    await new Promise((r) => setTimeout(r, POLL_MS));
  }

  store.save(true);
  releaseLock();
  return 0;
}

module.exports = { runRecorder, locked, LOCK, POLL_MS };
