'use strict';

const path = require('node:path');
const { spawn } = require('node:child_process');
const { locked } = require('./recorder');

const ENTRY = path.join(__dirname, '..', 'bin', 'recorder.js');

// The startup hook normally launches the recorder when Herdr starts. Opening
// the town also checks, so the plugin works immediately after being linked
// without waiting for a Herdr restart.
function ensureRecorder() {
  try {
    if (locked()) return false;
    const child = spawn(process.execPath, [ENTRY, '--quiet'], {
      detached: true,
      stdio: 'ignore',
      cwd: path.join(__dirname, '..'),
      env: process.env,
    });
    child.unref();
    return true;
  } catch {
    // Without a recorder buildings simply stop growing; the view still works.
    return false;
  }
}

module.exports = { ensureRecorder };
