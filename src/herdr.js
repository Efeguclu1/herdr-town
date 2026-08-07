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
  call, snapshot, listAgents, listWorkspaces, focusAgent, promptAgent, BIN,
};
