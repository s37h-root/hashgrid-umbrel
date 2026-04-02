'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { ConnectionState, PAIRING_CHARSET, generatePairingCode } = require('../bridge/RelayClient');

describe('RelayClient', () => {
  it('generates an 8-character pairing code from valid charset', () => {
    const code = generatePairingCode();
    assert.equal(code.length, 8);
    for (const ch of code) {
      assert.ok(PAIRING_CHARSET.includes(ch), `Invalid char: ${ch}`);
    }
  });

  it('generates unique codes', () => {
    const codes = new Set();
    for (let i = 0; i < 100; i++) {
      codes.add(generatePairingCode());
    }
    assert.equal(codes.size, 100);
  });

  it('has correct connection states', () => {
    assert.equal(ConnectionState.DISCONNECTED, 'disconnected');
    assert.equal(ConnectionState.CONNECTING, 'connecting');
    assert.equal(ConnectionState.WAITING_FOR_PEER, 'waitingForPeer');
    assert.equal(ConnectionState.CONNECTED, 'connected');
  });
});
