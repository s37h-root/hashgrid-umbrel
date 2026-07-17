'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { createLiveActivityPusher } = require('../bridge/LiveActivityPusher');

const baseDeps = (over) => ({
  getMiners: () => [{ minerProtocol: 'bitaxeHTTP', ip: '1' }],
  fetchStats: async () => ({ online: true, hashrateGH: 500, tempC: 60 }),
  decider: { decide: () => ({ push: true, priority: 10 }) },
  getActivityState: () => ({ enabled: true, active: true }),
  now: () => 1_700_000_000_000,
  sendPush: () => {},
  ...over,
});

describe('LiveActivityPusher', () => {
  it('does nothing when disabled', async () => {
    let calls = 0;
    const p = createLiveActivityPusher(baseDeps({ getActivityState: () => ({ enabled: false, active: false }), sendPush: () => calls++ }));
    await p.tick();
    assert.equal(calls, 0);
  });

  it('sends event:start when enabled and no activity is active', async () => {
    const sent = [];
    const p = createLiveActivityPusher(baseDeps({ getActivityState: () => ({ enabled: true, active: false }), sendPush: (x) => sent.push(x) }));
    await p.tick();
    assert.equal(sent.length, 1);
    assert.equal(sent[0].event, 'start');
    assert.equal(sent[0].attributes.fleetName, 'HashPulse');
  });

  it('sends event:update when an activity is active', async () => {
    const sent = [];
    const p = createLiveActivityPusher(baseDeps({ sendPush: (x) => sent.push(x) }));
    await p.tick();
    assert.equal(sent[0].event, 'update');
  });
});
