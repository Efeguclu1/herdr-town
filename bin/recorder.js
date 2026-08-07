'use strict';

// Two modes:
//   node bin/recorder.js           run the recorder loop in the foreground
//   node bin/recorder.js --spawn   detach a background recorder and exit
//
// Herdr startup hooks are meant to initialise and exit rather than stay
// running, so the hook uses --spawn and the detached child does the work.

const path = require('node:path');
const { spawn } = require('node:child_process');
const { runRecorder, locked } = require('../src/recorder');

const SELF = path.join(__dirname, 'recorder.js');
const quiet = process.argv.includes('--quiet');
const log = quiet ? () => {} : (m) => process.stdout.write(`herdr-town recorder: ${m}\n`);

if (process.argv.includes('--spawn')) {
  if (locked()) {
    log('already running');
    process.exit(0);
  }
  const child = spawn(process.execPath, [SELF, '--quiet'], {
    detached: true,
    stdio: 'ignore',
    cwd: path.dirname(__dirname),
    env: process.env,
  });
  child.unref();
  log(`started (pid ${child.pid})`);
  process.exit(0);
}

runRecorder({ log }).then((code) => process.exit(code)).catch((e) => {
  process.stderr.write(`herdr-town recorder: ${e && e.stack ? e.stack : e}\n`);
  process.exit(1);
});
