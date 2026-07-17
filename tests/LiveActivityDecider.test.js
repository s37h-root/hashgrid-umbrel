'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { createDecider } = require('../bridge/LiveActivityDecider');

const fleet = (o) => ({ totalHashrateGH: 1000, onlineCount: 3, standbyCount: 0, offlineCount: 0, avgTemperatureC: 60, isHighTemperature: false, ...o });

describe('LiveActivityDecider', () => {
  it('pushes priority-10 on first observation, then not again with no change', () => {
    const d = createDecider();
    const r1 = d.decide(fleet(), 0);
    assert.equal(r1.push, true);
    assert.equal(r1.priority, 10);
    const r2 = d.decide(fleet(), 30_000);
    assert.equal(r2.push, false);
  });

  it('pushes priority-10 when a miner drops offline', () => {
    const d = createDecider();
    d.decide(fleet(), 0);
    const r = d.decide(fleet({ onlineCount: 2, offlineCount: 1 }), 120_000);
    assert.equal(r.push, true);
    assert.equal(r.priority, 10);
  });

  it('rate-caps: a second delta within 60s downgrades to priority-5', () => {
    // minPushIntervalMs disabled here so the pri-10->pri-5 rate-cap-downgrade
    // path can be exercised in isolation from the global min-interval floor
    // (see the dedicated min-interval-floor tests below).
    const d = createDecider({ hiPriMinIntervalMs: 60_000, minPushIntervalMs: 0 });
    d.decide(fleet(), 0);                                   // pri-10 @0
    const r = d.decide(fleet({ offlineCount: 1, onlineCount: 2 }), 30_000); // within 60s
    assert.equal(r.push, true);
    assert.equal(r.priority, 5);
  });

  it('emits a priority-5 heartbeat after the heartbeat interval with no change', () => {
    const d = createDecider({ heartbeatMs: 100_000 });
    d.decide(fleet(), 0);
    assert.equal(d.decide(fleet(), 50_000).push, false);
    const hb = d.decide(fleet(), 101_000);
    assert.equal(hb.push, true);
    assert.equal(hb.priority, 5);
  });

  it('ignores a sub-threshold hashrate wobble', () => {
    const d = createDecider();
    d.decide(fleet({ totalHashrateGH: 1000 }), 0);
    const r = d.decide(fleet({ totalHashrateGH: 1050 }), 120_000); // +5% < 10%
    assert.equal(r.push, false);
  });

  it('suppresses a flapping delta that arrives before the global min-push-interval floor', () => {
    const d = createDecider();
    d.decide(fleet(), 0); // pri-10 @0, lastPushMs=0
    const suppressed = d.decide(fleet({ onlineCount: 2, offlineCount: 1 }), 60_000); // delta, but <120s since last push
    assert.equal(suppressed.push, false);
    assert.equal(suppressed.reason, 'delta-suppressed-min-interval');
  });

  it('fires the same delta once the global min-push-interval floor has elapsed', () => {
    const d = createDecider();
    d.decide(fleet(), 0); // pri-10 @0, lastPushMs=0
    const suppressed = d.decide(fleet({ onlineCount: 2, offlineCount: 1 }), 60_000); // suppressed, lastPushMs unchanged
    assert.equal(suppressed.push, false);
    const fired = d.decide(fleet({ onlineCount: 2, offlineCount: 1 }), 130_000); // >=120s since last push
    assert.equal(fired.push, true);
  });
});
