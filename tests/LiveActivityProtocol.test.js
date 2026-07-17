'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { EnvelopeType, createLiveActivityPushEnvelope } = require('../bridge/BridgeProtocol');

describe('Live Activity protocol', () => {
  it('declares the two relay-terminated envelope types', () => {
    assert.equal(EnvelopeType.LIVE_ACTIVITY_CONTROL, 'liveActivityControl');
    assert.equal(EnvelopeType.LIVE_ACTIVITY_PUSH, 'liveActivityPush');
  });

  it('wraps a push object as a base64 plaintext envelope', () => {
    const push = { event: 'update', priority: 10, contentState: { totalHashrateGH: 5 }, staleDate: null };
    const env = createLiveActivityPushEnvelope(push);
    assert.equal(env.type, 'liveActivityPush');
    const decoded = JSON.parse(Buffer.from(env.payload, 'base64').toString());
    assert.deepEqual(decoded, push);
  });
});
