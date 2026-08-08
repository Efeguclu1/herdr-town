'use strict';

// The choice parser decides which keystroke gets sent to an agent, so its
// failure mode is approving something nobody chose. These tests pin down two
// things: what it must parse, and just as importantly what it must refuse.
//
//   node tests/choices.test.js

const { parseChoices } = require('../src/choices');

const C = {
  r: '\x1b[0m', b: '\x1b[1m', g: '\x1b[38;5;114m', red: '\x1b[38;5;203m', d: '\x1b[38;5;245m',
};

let failures = 0;
let checks = 0;

function check(name, cond, detail) {
  checks++;
  if (cond) {
    process.stdout.write(`  ${C.g}ok${C.r}   ${name}\n`);
    return true;
  }
  failures++;
  process.stdout.write(`  ${C.red}FAIL${C.r} ${name}${detail ? ` — ${detail}` : ''}\n`);
  return false;
}

// --- must parse, with the exact keys the agent printed -------------------

const CLAUDE = `
Do you want to proceed?
❯ 1. Yes
  2. Yes, and don't ask again for bash commands in /Users/x
  3. No, and tell Claude what to do differently (esc)
`;

const CURSOR = `
  Run this command?

  Run (once) (y)
  Run and don't ask again (a)
  Skip (esc or n)
`;

const CODEX = `
Allow command?
  [y] yes, run it
  [n] no, skip
`;

{
  const r = parseChoices(CLAUDE);
  check('claude numbered prompt parses', !!r && r.options.length === 3);
  check('claude keys are the printed digits',
    !!r && r.options.map((o) => o.key).join('') === '123',
    r && r.options.map((o) => o.key).join(','));
  check('claude question captured', !!r && /do you want to proceed/i.test(r.question));

  const c = parseChoices(CURSOR);
  check('cursor trailing-paren prompt parses', !!c && c.options.length === 3);
  check('cursor keys read off the screen',
    !!c && c.options.map((o) => o.key).join(',') === 'y,a,esc',
    c && c.options.map((o) => o.key).join(','));

  const x = parseChoices(CODEX);
  check('codex bracket prompt parses', !!x && x.options.length === 2);
  check('codex keys are y and n',
    !!x && x.options.map((o) => o.key).join(',') === 'y,n',
    x && x.options.map((o) => o.key).join(','));
}

// --- must refuse ---------------------------------------------------------

{
  // Numbered prose is the most likely false positive: agents write lists.
  const prose = `
Here is my plan:

1. First we refactor the transport layer and make sure the tests still pass

Then, after that lands:

2. We can delete the shim entirely
`;
  check('scattered numbered prose is not a prompt', parseChoices(prose) === null);

  // The dangerous family: options with no printed key. Answering these would
  // mean counting rows from the cursor and computing a keystroke.
  const arrows = `
? Which approach do you want?
❯ Patch the client
  Bump the library
  Neither
  ↑/↓ to navigate · enter to select · esc to cancel
`;
  check('arrow-navigated form with no printed keys is refused',
    parseChoices(arrows) === null);

  check('a single option is not a menu',
    parseChoices('Proceed?\n  1. Yes\n') === null);

  check('empty screen is not a menu', parseChoices('') === null);

  // Duplicate keys mean we misread something that is not a menu.
  check('duplicate keys are refused',
    parseChoices('Pick?\n  1. one\n  1. also one\n') === null);
}

// --- the safety property -------------------------------------------------
//
// Before sending, the screen is re-read and re-parsed, and the signature is
// compared with what the user was shown. That is what stops a keystroke
// landing in a prompt that has already moved on.

{
  const a = parseChoices(CLAUDE);
  const again = parseChoices(CLAUDE);
  check('signature is stable for an unchanged screen',
    a.signature === again.signature);

  const reordered = parseChoices(`
Do you want to proceed?
❯ 1. No, and tell Claude what to do differently
  2. Yes
  3. Yes, and don't ask again for bash commands in /Users/x
`);
  check('signature changes when the options are reordered',
    a.signature !== reordered.signature,
    'a reorder that went undetected would send the wrong answer');

  const different = parseChoices(`
Do you want to allow this file write?
❯ 1. Yes
  2. No
`);
  check('signature changes when the question changes',
    a.signature !== different.signature);
}

process.stdout.write(`\n${C.b}${checks - failures}/${checks} checks passed${C.r}\n`);
if (failures) {
  process.stdout.write(`${C.red}${failures} failed${C.r}\n`);
  process.exitCode = 1;
}
