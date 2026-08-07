'use strict';

const path = require('node:path');

// Herdr's agent states, plus two states of our own for buildings whose agents
// have gone: `complete` (it was finished) and `ruin` (it never was). Live work
// sorts to the left, the standing skyline to the right.
const STATE_RANK = {
  blocked: 0, working: 1, done: 2, idle: 3, unknown: 4, complete: 5, ruin: 6,
};

function normalizeTitle(t) {
  return String(t || '')
    .replace(/\s+/g, ' ')
    .trim();
}

// A "feature" is the unit of work a building represents. Two agents whose
// panes report the same task title are collaborating on the same feature, so
// they get one building and stand at it together. Falling back to the pane id
// keeps untitled agents on separate buildings rather than collapsing them all
// into one.
function featureOf(agent) {
  const title = normalizeTitle(agent.terminal_title_stripped || agent.terminal_title);
  if (title) return { key: title.toLowerCase(), label: title };
  const dir = agent.foreground_cwd || agent.cwd;
  if (dir) {
    const base = path.basename(dir);
    if (base && base !== '~') return { key: `dir:${base.toLowerCase()}`, label: base };
  }
  return { key: `pane:${agent.pane_id}`, label: agent.agent || 'agent' };
}

// The building's height comes from accumulated working time. Paced so a town
// develops across days of real use rather than topping out in one sitting:
// half an hour of agent work per floor, ~4 hours to reach full height.
const FLOOR_MINUTES = 30;
const MAX_FLOORS = 8;

function floorsFor(ms) {
  const minutes = ms / 60000;
  return Math.max(1, Math.min(MAX_FLOORS, 1 + Math.floor(minutes / FLOOR_MINUTES)));
}

// Roll a building's workers up into one state. Blocked wins over everything —
// the whole point of the view is that a stalled agent is impossible to miss.
function rollup(states) {
  if (states.includes('blocked')) return 'blocked';
  if (states.includes('working')) return 'working';
  if (states.includes('done')) return 'done';
  if (states.includes('idle')) return 'idle';
  return 'unknown';
}

function buildWorld(snapshot, store) {
  const byWorkspace = new Map();

  for (const ws of snapshot.workspaces) {
    byWorkspace.set(ws.workspace_id, {
      id: ws.workspace_id,
      label: ws.label && ws.label !== '~' ? ws.label : `workspace ${ws.number}`,
      number: ws.number,
      focused: !!ws.focused,
      status: ws.agent_status || 'unknown',
      buildings: new Map(),
      agentCount: 0,
      counts: { working: 0, blocked: 0, idle: 0, done: 0, unknown: 0 },
    });
  }

  for (const agent of snapshot.agents) {
    let town = byWorkspace.get(agent.workspace_id);
    if (!town) {
      // An agent in a workspace the list did not report (racing with a close).
      // Give it a home rather than dropping it.
      town = {
        id: agent.workspace_id,
        label: agent.workspace_id,
        number: 0,
        focused: false,
        status: 'unknown',
        buildings: new Map(),
        agentCount: 0,
        counts: { working: 0, blocked: 0, idle: 0, done: 0, unknown: 0 },
      };
      byWorkspace.set(agent.workspace_id, town);
    }

    const feat = featureOf(agent);
    const key = `${town.id}::${feat.key}`;
    let b = town.buildings.get(key);
    if (!b) {
      b = { key, label: feat.label, workers: [], state: 'unknown', floors: 1, workMs: 0 };
      town.buildings.set(key, b);
    }

    const state = agent.agent_status || 'unknown';
    b.workers.push({
      paneId: agent.pane_id,
      name: agent.agent || 'agent',
      state,
      focused: !!agent.focused,
      title: feat.label,
    });

    town.agentCount++;
    if (town.counts[state] === undefined) town.counts.unknown++;
    else town.counts[state]++;
  }

  const towns = [];
  for (const town of byWorkspace.values()) {
    const buildings = [...town.buildings.values()];
    for (const b of buildings) {
      b.state = rollup(b.workers.map((w) => w.state));
      b.workMs = store.workMs(b.key);
      b.floors = floorsFor(b.workMs);
      b.workers.sort((x, y) => STATE_RANK[x.state] - STATE_RANK[y.state]);
    }
    // Most urgent first, then biggest, so a blocked building is always the
    // leftmost thing you look at.
    buildings.sort((a, b) => {
      const d = STATE_RANK[a.state] - STATE_RANK[b.state];
      if (d !== 0) return d;
      if (b.floors !== a.floors) return b.floors - a.floors;
      return a.label.localeCompare(b.label);
    });
    town.buildingList = buildings;
    towns.push(town);
  }

  towns.sort((a, b) => (a.number || 999) - (b.number || 999));
  return { towns, at: snapshot.at };
}

// Credit working time to the features that earned it since the last poll.
function accrue(world, store, elapsedMs) {
  if (!(elapsedMs > 0) || elapsedMs > 60000) return; // ignore first tick / long sleeps
  for (const town of world.towns) {
    for (const b of town.buildingList) {
      const working = b.workers.filter((w) => w.state === 'working').length;
      if (working > 0) store.addWork(b.key, elapsedMs * working);
    }
  }
}

// Record what each live building is, so it can be rebuilt once its agents
// are gone.
function record(world, store) {
  for (const town of world.towns) {
    for (const b of town.buildingList) {
      store.observe(b.key, { workspaceId: town.id, label: b.label, state: b.state });
    }
  }
}

// A feature only counts as a real building once it has had some work put into
// it. Without this, glancing at an agent for one poll would leave a permanent
// structure behind.
const MIN_STANDING_MS = 60000;

// Put the remembered buildings back into each town. These have no workers:
// a finished feature stands as a completed building, an unfinished one that
// was abandoned stands as a ruin.
function addGhosts(world, store) {
  for (const town of world.towns) {
    const live = new Set(town.buildingList.map((b) => b.key));
    for (const f of store.featuresFor(town.id)) {
      if (live.has(f.key)) continue;
      if (!f.done && f.ms < MIN_STANDING_MS) continue;
      town.buildingList.push({
        key: f.key,
        label: f.label,
        workers: [],
        state: f.done ? 'complete' : 'ruin',
        workMs: f.ms,
        floors: floorsFor(f.ms),
        standing: true,
        lastSeen: f.seen || 0,
      });
    }
    town.buildingList.sort((a, b) => {
      const d = STATE_RANK[a.state] - STATE_RANK[b.state];
      if (d !== 0) return d;
      if (b.floors !== a.floors) return b.floors - a.floors;
      return a.label.localeCompare(b.label);
    });
  }
  return world;
}

module.exports = {
  buildWorld, accrue, record, addGhosts, floorsFor, rollup,
  MAX_FLOORS, FLOOR_MINUTES, STATE_RANK,
};
