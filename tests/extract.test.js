'use strict';

// Runs the message extractor over every captured agent screen in
// tests/fixtures/ and asserts the properties that must hold for any agent,
// whichever CLI produced it.
//
//   node tests/extract.test.js
//
// Fixtures are raw `herdr agent read --source visible` output. Add one with
// tools/capture.js. The extractor deliberately has no per-agent branches, so
// every fixture is tested by the same rules.

const fs = require('node:fs');
const path = require('node:path');
const {
  extract, summarize, isRule, isChrome, isHintBar, stripAnsi,
} = require('../src/message');

const DIR = path.join(__dirname, 'fixtures');
const C = {
  r: '\x1b[0m', b: '\x1b[1m', g: '\x1b[38;5;114m', red: '\x1b[38;5;203m', y: '\x1b[38;5;221m', d: '\x1b[38;5;245m',
};

let failures = 0;
let checks = 0;

function check(name, cond, detail) {
  checks++;
  if (cond) return true;
  failures++;
  process.stdout.write(`    ${C.red}FAIL${C.r} ${name}${detail ? `: ${detail}` : ''}\n`);
  return false;
}

// Furniture the extractor should never leave in a message. These are the
// shapes that make a bubble look broken rather than informative.
const LEFTOVER_CHROME = [
  { re: /^\s*[❯›→▶]\s/, why: 'input prompt line survived' },
  { re: /esc to interrupt/i, why: 'interrupt hint survived' },
  { re: /[↓↑]\s*[\d.]+k?\s*tokens/i, why: 'token counter survived' },
];

function runFixture(file) {
  const raw = fs.readFileSync(path.join(DIR, file), 'utf8');
  const label = file.replace(/\.txt$/, '');
  const res = extract(raw);
  const teaser = summarize(res.lines);
  const rawLines = stripAnsi(raw).split('\n').filter((l) => l.trim()).length;

  process.stdout.write(`  ${C.b}${label}${C.r} ${C.d}${rawLines} lines in -> ${res.lines.length} out${C.r}\n`);

  check('produces a message', !res.empty, 'extractor returned nothing');
  check('produces a teaser', teaser.length > 0, 'summarize() returned empty');

  for (const line of res.lines) {
    for (const { re, why } of LEFTOVER_CHROME) {
      if (re.test(line)) check(why, false, JSON.stringify(line.slice(0, 60)));
    }
    if (isRule(line)) check('box rule survived', false, JSON.stringify(line.slice(0, 40)));
  }

  // A teaser is what a bubble shows; furniture there is the most visible
  // possible failure.
  check('teaser is not furniture', !isChrome(teaser) && !isHintBar(teaser),
    JSON.stringify(teaser.slice(0, 60)));
  check('teaser has real words', /[A-Za-zÀ-ÿ]{3}/.test(teaser),
    JSON.stringify(teaser.slice(0, 60)));

  if (!res.empty) process.stdout.write(`    ${C.d}"${teaser.slice(0, 76)}"${C.r}\n`);
}

function main() {
  if (!fs.existsSync(DIR)) {
    process.stdout.write('no fixtures directory; nothing to test\n');
    return;
  }
  const files = fs.readdirSync(DIR).filter((f) => f.endsWith('.txt')).sort();
  if (!files.length) {
    process.stdout.write('no fixtures yet. Capture one:\n  node tools/capture.js <pane-id> <name>\n');
    return;
  }

  process.stdout.write(`${C.b}extractor over ${files.length} captured agent screen(s)${C.r}\n\n`);
  for (const f of files) runFixture(f);

  const agents = new Set(files.map((f) => f.split('-')[0]));
  process.stdout.write(`\n${C.b}${checks - failures}/${checks} checks passed${C.r} `);
  process.stdout.write(`${C.d}across ${agents.size} agent(s): ${[...agents].join(', ')}${C.r}\n`);
  if (failures) {
    process.stdout.write(`${C.red}${failures} failed${C.r}\n`);
    process.exitCode = 1;
  } else {
    process.stdout.write(`${C.g}ok${C.r}\n`);
  }
}

main();
