'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

// Isolate persistence so this file doesn't touch the repo ./data dir. Must be
// set BEFORE requiring the server (persistence captures DATA_DIR at load).
const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'hg-auth-'));
process.env.DATA_DIR = TMP_DATA;

const { createServer } = require('../bridge/server');

// Minimal fake exercising every property/method the control routes touch.
function fakeBridgeManager() {
  return {
    state: 'connected',
    peerConnected: false,
    connectedDevice: null,
    startTime: Date.now(),
    code: 'ABCD1234',
    identityFingerprint: '00:11:22:33:44:55',
    pairedAppKey: null,
    pairingModeActive: false,
    lastUnknownDeviceAttempt: null,
    relay: { fingerprint: 'aa:bb:cc' },
    scanner: {
      miners: [{ ip: '192.168.1.50', deviceModel: 'BitAxe', minerProtocol: 'bitaxeHTTP' }],
      getSubnet: () => '192.168.1',
      setCustomSubnet: () => {},
    },
    _regenerated: false,
    regenerateCode() { this._regenerated = true; this.code = 'NEWCODE1'; },
    enterPairingMode() { this.pairingModeActive = true; },
  };
}

describe('control API auth', () => {
  let server;
  let baseURL;
  let token;
  const manager = fakeBridgeManager();

  before(async () => {
    const app = createServer(manager);
    await new Promise((resolve) => {
      server = app.listen(0, '127.0.0.1', resolve);
    });
    const { port } = server.address();
    baseURL = `http://127.0.0.1:${port}`;
    // The test connects over loopback, so /api/session hands out the token —
    // exactly how the legitimate Umbrel-proxied UI bootstraps.
    const res = await fetch(`${baseURL}/api/session`);
    assert.equal(res.status, 200);
    token = (await res.json()).token;
    assert.ok(token && token.length >= 32, 'session returns a token');
  });

  after(() => { if (server) server.close(); });

  it('rejects an unauthenticated mutating request (401)', async () => {
    const res = await fetch(`${baseURL}/api/pairing/enter`, { method: 'POST' });
    assert.equal(res.status, 401);
    assert.equal(manager.pairingModeActive, false, 'side effect did not run');
  });

  it('rejects an unauthenticated secret read (401)', async () => {
    const res = await fetch(`${baseURL}/api/code`);
    assert.equal(res.status, 401);
  });

  it('rejects a wrong token (401)', async () => {
    const res = await fetch(`${baseURL}/api/code`, {
      headers: { 'X-Auth-Token': 'not-the-real-token-padded-to-length-000000000000000000000000000' },
    });
    assert.equal(res.status, 401);
  });

  it('accepts a correctly-authed mutating request (200) and runs the side effect', async () => {
    const res = await fetch(`${baseURL}/api/code/regenerate`, {
      method: 'POST',
      headers: { 'X-Auth-Token': token },
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.code, 'NEWCODE1');
    assert.equal(manager._regenerated, true);
  });

  it('accepts the token via Authorization: Bearer too', async () => {
    const res = await fetch(`${baseURL}/api/miners`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.length, 1);
  });

  it('serves static assets without a token (UI can bootstrap)', async () => {
    const res = await fetch(`${baseURL}/app.js`);
    assert.equal(res.status, 200);
  });
});
