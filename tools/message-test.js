'use strict';

// Dev tool: run the extractor against every live agent and show what survives.
// This is how the chrome stripper gets judged, since the only real test is
// other people's agents.
//
//   node tools/message-test.js            summary across all agents
//   node tools/message-test.js w2:p2      full before/after for one pane

const { execFileSync } = require('node:child_process');
const { extract, summarize, isRule, isChrome, splitAtInputBox, stripAnsi } = require('../src/message');

const BIN = process.env.HERDR_BIN_PATH || 'herdr';
const C = {
  r: '\x1b[0m', b: '\x1b[1m', dim: '\x1b[2m',
  g: '\x1b[38;5;114m', y: '\x1b[38;5;221m', c: '\x1b[38;5;80m',
  red: '\x1b[38;5;203m', grey: '\x1b[38;5;245m',
};

function sh(args) {
  return execFileSync(BIN, args, { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
}

const agents = JSON.parse(sh(['agent', 'list'])).result.agents;
const target = process.argv[2];

if (target) {
  const a = agents.find((x) => x.pane_id === target);
  const raw = sh(['agent', 'read', target, '--source', 'visible', '--format', 'text']);
  const all = stripAnsi(raw).replace(/\r/g, '').split('\n');
  const { cut } = splitAtInputBox(all);

  console.log(`${C.b}${C.c}=== ${target} (${a ? a.agent : '?'}) raw, classified ===${C.r}\n`);
  all.forEach((line, i) => {
    let tag = `${C.grey}keep ${C.r}`;
    if (i >= cut) tag = `${C.red}below-box${C.r}`;
    else if (isRule(line)) tag = `${C.y}rule ${C.r}`;
    else if (isChrome(line)) tag = `${C.y}chrome${C.r}`;
    console.log(`${String(i).padStart(3)} ${tag} ${C.dim}|${C.r} ${line.slice(0, 96)}`);
  });

  const res = extract(raw);
  console.log(`\n${C.b}${C.g}=== extracted (${res.lines.length} lines) ===${C.r}\n`);
  console.log(res.text);
  console.log(`\n${C.b}${C.c}=== bubble teaser ===${C.r}\n"${summarize(res.lines)}"`);
  process.exit(0);
}

console.log(`${C.b}Extractor across ${agents.length} live agents${C.r}\n`);
let ok = 0;
for (const a of agents) {
  let raw;
  try {
    raw = sh(['agent', 'read', a.pane_id, '--source', 'visible', '--format', 'text']);
  } catch (e) {
    console.log(`${C.red}FAIL${C.r} ${a.pane_id} ${a.agent}: ${e.message.split('\n')[0]}`);
    continue;
  }
  const before = stripAnsi(raw).split('\n').filter((l) => l.trim()).length;
  const res = extract(raw);
  const teaser = summarize(res.lines);
  const status = res.empty ? `${C.red}EMPTY${C.r}` : `${C.g}ok${C.r}   `;
  if (!res.empty) ok++;
  console.log(`${status} ${C.b}${a.pane_id.padEnd(7)}${C.r} ${a.agent.padEnd(7)} ${C.grey}${String(before).padStart(3)} -> ${String(res.lines.length).padStart(3)} lines${C.r}`);
  console.log(`       ${C.c}"${teaser}"${C.r}\n`);
}
console.log(`${C.b}${ok}/${agents.length} produced a message.${C.r}`);
