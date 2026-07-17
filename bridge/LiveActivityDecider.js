'use strict';

// Pure decision engine: given the current fleet aggregate + a monotonic clock,
// decide whether to push and at what apns-priority. All time is injected via
// nowMs so behavior is deterministic and testable.

const DEFAULTS = {
  hashrateSwingPct: 0.10,     // >10% total-hashrate change is a delta
  hiPriMinIntervalMs: 60_000, // <=1 priority-10 push per 60s
  heartbeatMs: 12 * 60 * 1000,
};

function _isDelta(prev, curr, swingPct) {
  if (!prev) return true; // first observation
  if (curr.onlineCount !== prev.onlineCount) return true;
  if (curr.standbyCount !== prev.standbyCount) return true;
  if (curr.offlineCount !== prev.offlineCount) return true;
  if (curr.isHighTemperature !== prev.isHighTemperature) return true;
  const base = prev.totalHashrateGH || 1;
  if (Math.abs(curr.totalHashrateGH - prev.totalHashrateGH) / base > swingPct) return true;
  return false;
}

function createDecider(opts = {}) {
  const cfg = { ...DEFAULTS, ...opts };
  let lastPushed = null;       // fleet snapshot at last push
  let lastPushMs = -Infinity;
  let lastHiPriMs = -Infinity;

  function decide(fleet, nowMs) {
    const delta = _isDelta(lastPushed, fleet, cfg.hashrateSwingPct);
    const heartbeatDue = nowMs - lastPushMs >= cfg.heartbeatMs;

    if (!delta && !heartbeatDue) return { push: false, priority: 5, reason: 'no-change' };

    let priority = 5;
    let reason = 'heartbeat';
    if (delta) {
      const withinCap = nowMs - lastHiPriMs < cfg.hiPriMinIntervalMs;
      priority = withinCap ? 5 : 10;
      reason = withinCap ? 'delta-ratecapped' : 'delta';
      if (priority === 10) lastHiPriMs = nowMs;
    }
    lastPushed = { ...fleet }; // defensive copy — don't alias a caller-reused fleet object
    lastPushMs = nowMs;
    return { push: true, priority, reason };
  }

  return { decide };
}

module.exports = { createDecider };
