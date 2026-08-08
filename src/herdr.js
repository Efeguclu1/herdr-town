'use strict';

const { execFile } = require('node:child_process');

// Talk to Herdr through HERDR_BIN_PATH rather than the raw socket. The socket
// is a Unix socket on macOS/Linux and a named pipe on Windows; the CLI hides
// that difference, and every CLI command is part of the plugin API.
const BIN = process.env.HERDR_BIN_PATH || 'herdr';

function call(args, timeout = 4000) {
  return new Promise((resolve, reject) => {
    execFile(BIN, args, { timeout, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => {
      if (err && !stdout) return reject(err);
      const text = String(stdout).trim();
      if (!text) return reject(new Error(`empty response from: herdr ${args.join(' ')}`));
      let parsed;
      try {
        parsed = JSON.parse(text);
      } catch {
        // Some commands print a usage line instead of JSON when the argument
        // shape is wrong; surface that rather than a parse error.
        return reject(new Error(text.split('\n')[0]));
      }
      if (parsed.error) return reject(new Error(parsed.error.message || parsed.error.code));
      resolve(parsed.result);
    });
  });
}

async function listAgents() {
  const r = await call(['agent', 'list']);
  return Array.isArray(r.agents) ? r.agents : [];
}

async function listWorkspaces() {
  const r = await call(['workspace', 'list']);
  return Array.isArray(r.workspaces) ? r.workspaces : [];
}

function focusAgent(paneId) {
  return call(['agent', 'focus', paneId]);
}

// Send raw keypresses. This is how a multiple-choice prompt gets answered:
// it is a modal menu, not a text box, so `prompt` would type into nothing.
function sendKeys(paneId, ...keys) {
  return call(['agent', 'send-keys', paneId, ...keys], 10000);
}

// Read an agent's screen right now, bypassing the view's cache. Used to
// re-verify a prompt immediately before answering it.
//
// `agent read --format text` prints the screen, not JSON, so this cannot go
// through call(): that would try to parse a terminal dump as a response.
function readNow(paneId) {
  return new Promise((resolve, reject) => {
    execFile(
      BIN,
      ['agent', 'read', paneId, '--source', 'visible', '--format', 'text'],
      { timeout: 6000, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err && !stdout) return reject(new Error(stderr || err.message));
        resolve(String(stdout));
      },
    );
  });
}

// Send a prompt to an agent. execFile passes argv directly with no shell, so
// the text needs no escaping however it is typed.
function promptAgent(paneId, text) {
  return call(['agent', 'prompt', paneId, text], 15000);
}

// One poll = one snapshot of the world. Workspaces are towns, so we keep every
// workspace even when it has no agents yet (an empty town is still a town).
async function snapshot() {
  const [workspaces, agents] = await Promise.all([listWorkspaces(), listAgents()]);
  return { workspaces, agents, at: Date.now() };
}

module.exports = {
  call, snapshot, listAgents, listWorkspaces, focusAgent, promptAgent,
  sendKeys, readNow, BIN,
};
