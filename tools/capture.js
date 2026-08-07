'use strict';

// Save an agent's raw screen as a test fixture.
//
//   node tools/capture.js w2:pF codex-blocked
//
// The extractor can only be trusted on agents whose screens we have actually
// seen. Herdr supports 19 agent CLIs; this repo has real captures for the ones
// its author runs. If the town shows nonsense for your agent, capture it and
// open an issue with the file: that is the whole contribution.

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const BIN = process.env.HERDR_BIN_PATH || 'herdr';
const [, , paneId, name] = process.argv;

if (!paneId || !name) {
  process.stderr.write('usage: node tools/capture.js <pane-id> <fixture-name>\n');
  process.stderr.write('  e.g. node tools/capture.js w2:pF codex-blocked\n');
  process.exit(1);
}

const raw = execFileSync(BIN, ['agent', 'read', paneId, '--source', 'visible', '--format', 'text'], {
  encoding: 'utf8',
  maxBuffer: 8 * 1024 * 1024,
});

const dir = path.join(__dirname, '..', 'tests', 'fixtures');
fs.mkdirSync(dir, { recursive: true });
const file = path.join(dir, `${name.replace(/[^\w.-]/g, '-')}.txt`);
fs.writeFileSync(file, raw, 'utf8');

process.stdout.write(`saved ${path.relative(process.cwd(), file)} (${raw.split('\n').length} lines)\n`);
process.stdout.write('Check it for anything private before committing or attaching it.\n');
