'use strict';

// Orchestration only — no parsing/decision logic lives here. Collaborators are
// injected so this ticks against fakes in tests and real network/state in
// BridgeManager. See LiveActivityStats.js (parse/aggregate/content-state) and
// LiveActivityDecider.js (push/priority decision) for the pure logic this
// wires together.

const { aggregateFleet, buildContentState } = require('./LiveActivityStats');

const SPARKLINE_MAX = 40;

function createLiveActivityPusher({ getMiners, fetchStats, decider, sendPush, getActivityState, now }) {
  const sparkline = [];

  async function tick() {
    const state = getActivityState(); // { active, enabled }
    if (!state.enabled) return;

    const miners = getMiners();
    const stats = await Promise.all(miners.map((m) => fetchStats(m))); // parseMinerStats already applied
    const fleet = aggregateFleet(stats);

    sparkline.push(fleet.totalHashrateGH);
    if (sparkline.length > SPARKLINE_MAX) sparkline.shift();

    const nowMs = now();
    const decision = decider.decide(fleet, nowMs);
    if (!decision.push) return;

    const cs = buildContentState(fleet, sparkline, nowMs);
    if (!state.active) {
      sendPush({
        event: 'start',
        priority: decision.priority,
        contentState: cs,
        staleDate: null,
        attributesType: 'MiningActivityAttributes',
        attributes: { fleetName: 'HashPulse' },
        alert: { title: 'Fleet monitoring', body: 'Live Activity started' },
      });
    } else {
      sendPush({
        event: 'update',
        priority: decision.priority,
        contentState: cs,
        staleDate: Math.floor(nowMs / 1000) + 600,
      });
    }
  }

  return { tick };
}

module.exports = { createLiveActivityPusher };
