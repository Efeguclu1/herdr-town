'use strict';

// Stable identities keep polling/re-sorting from changing an action's target.
function entriesFor(world) {
  const out = [];
  for (const town of world.towns) {
    out.push({ id: `town:${town.id}`, kind: 'town', town });
    for (const building of town.buildingList) {
      out.push({ id: `building:${building.key}`, kind: 'building', town, building });
      for (const worker of building.workers) {
        out.push({ id: `worker:${worker.paneId}`, kind: 'worker', town, building, worker });
      }
    }
  }
  return out;
}

class AttentionClock {
  constructor() { this.since = new Map(); }

  // Only successful snapshots update the clock. These are observed waits,
  // not a claim about when an agent actually became blocked before launch.
  update(world, now = Date.now()) {
    const blocked = new Set(entriesFor(world)
      .filter((e) => e.worker && e.worker.state === 'blocked')
      .map((e) => e.worker.paneId));
    for (const id of this.since.keys()) if (!blocked.has(id)) this.since.delete(id);
    for (const id of blocked) if (!this.since.has(id)) this.since.set(id, now);
  }
}

function navigationEntries(world, { kind, query = '', townId, clock }) {
  const terms = query.toLocaleLowerCase().trim().split(/\s+/).filter(Boolean);
  let entries = entriesFor(world);
  if (kind === 'attention') {
    entries = entries.filter((e) => e.worker && e.worker.state === 'blocked');
    entries.sort((a, b) => (clock.since.get(a.worker.paneId) || 0)
      - (clock.since.get(b.worker.paneId) || 0) || a.id.localeCompare(b.id));
  } else if (kind === 'buildings') {
    entries = entries.filter((e) => e.kind === 'building' && e.town.id === townId);
  }
  return entries.filter((e) => {
    const text = [e.town.label, e.town.id, e.building && e.building.label,
      e.worker && e.worker.name, e.worker && e.worker.paneId].filter(Boolean)
      .join(' ').toLocaleLowerCase();
    return terms.every((term) => text.includes(term));
  });
}

module.exports = { entriesFor, AttentionClock, navigationEntries };
