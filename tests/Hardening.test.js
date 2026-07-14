'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');

// Isolate persistence for this file so it doesn't touch the repo ./data dir.
const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'hg-hardening-'));
process.env.DATA_DIR = TMP_DATA;

const {
  validateTarget,
  validateFreeform,
  requireInt,
  forwardBitAxeAction,
  MinerProxy,
} = require('../bridge/MinerProxy');
const bridgeCrypto = require('../bridge/BridgeCrypto');
const { createBridgeInfoResponse } = require('../bridge/BridgeProtocol');

// ---- SSRF: Layer A structural target validation ----

describe('validateTarget (SSRF Layer A)', () => {
  it('accepts a private IPv4 with no port', () => {
    assert.deepStrictEqual(validateTarget('192.168.1.50'), { host: '192.168.1.50', port: null });
  });

  it('accepts private IPv4 with an allowed port', () => {
    assert.deepStrictEqual(validateTarget('10.0.0.5:4028'), { host: '10.0.0.5', port: 4028 });
    assert.deepStrictEqual(validateTarget('192.168.1.9:4029'), { host: '192.168.1.9', port: 4029 });
  });

  it('accepts the 172.16/12 private range but rejects 172.32', () => {
    assert.equal(validateTarget('172.16.0.1').host, '172.16.0.1');
    assert.throws(() => validateTarget('172.32.0.1'), /Invalid miner target/);
  });

  it('rejects loopback', () => {
    assert.throws(() => validateTarget('127.0.0.1:8080'), /Invalid miner target/);
  });

  it('rejects link-local (cloud metadata)', () => {
    assert.throws(() => validateTarget('169.254.169.254'), /Invalid miner target/);
  });

  it('rejects public IPs', () => {
    assert.throws(() => validateTarget('8.8.8.8'), /Invalid miner target/);
  });

  it('rejects DNS names outright', () => {
    assert.throws(() => validateTarget('evil.example.com'), /Invalid miner target/);
  });

  it('rejects a disallowed port even on a private IP', () => {
    assert.throws(() => validateTarget('192.168.1.1:22'), /Invalid miner target/);
  });

  it('rejects paths, credentials and whitespace', () => {
    assert.throws(() => validateTarget('192.168.1.1/api'), /Invalid miner target/);
    assert.throws(() => validateTarget('user@192.168.1.1'), /Invalid miner target/);
    assert.throws(() => validateTarget('192.168.1.1 '), /Invalid miner target/);
  });

  it('rejects octets > 255', () => {
    assert.throws(() => validateTarget('192.168.1.999'), /Invalid miner target/);
  });
});

// ---- Layer D: parameter escaping ----

describe('cgminer parameter escaping (SSRF Layer D)', () => {
  it('rejects free-form values containing command separators', () => {
    for (const bad of ['a,b', 'a|b', 'a"b', 'a\\b', 'a\nb']) {
      assert.throws(() => validateFreeform(bad, 'url'), /Invalid value/);
    }
  });

  it('accepts a normal stratum URL', () => {
    assert.equal(validateFreeform('stratum+tcp://pool.example:3333', 'url'), 'stratum+tcp://pool.example:3333');
  });

  it('requireInt rejects non-integer numeric params', () => {
    assert.throws(() => requireInt('6,0', 'mhz'), /Invalid value/);
    assert.throws(() => requireInt('abc', 'mode'), /Invalid value/);
    assert.equal(requireInt('600', 'mhz'), 600);
  });
});

// ---- Layer C: BitAxe fixed action map ----

describe('forwardBitAxeAction (SSRF Layer C)', () => {
  it('rejects an unknown action without touching the network', async () => {
    await assert.rejects(
      forwardBitAxeAction('192.168.1.50', '../../etc/passwd', {}, null),
      /Unknown action/
    );
  });
});

// ---- Replay / freshness / discovered-miner allowlist ----

function fakeScanner(miners) {
  return { miners: miners || [], scan: async () => {} };
}

describe('MinerProxy replay + freshness + allowlist', () => {
  it('rejects a minerAction with no issuedAt (legacy app)', async () => {
    const proxy = new MinerProxy(fakeScanner([{ ip: '192.168.1.50', port: 80 }]));
    const resp = await proxy.handleRequest({
      id: 'a1', type: 'minerAction', target: '192.168.1.50', action: 'restart',
    });
    assert.equal(resp.success, false);
    assert.match(resp.error, /requires a newer version/);
  });

  it('rejects a minerAction whose issuedAt is 5 minutes old', async () => {
    const proxy = new MinerProxy(fakeScanner([{ ip: '192.168.1.50', port: 80 }]));
    const resp = await proxy.handleRequest({
      id: 'a2', type: 'minerAction', target: '192.168.1.50', action: 'restart',
      issuedAt: Math.floor(Date.now() / 1000) - 300,
    });
    assert.equal(resp.success, false);
    assert.match(resp.error, /expired/);
  });

  it('rejects a replayed request id as duplicate', async () => {
    const proxy = new MinerProxy(fakeScanner([{ ip: '192.168.1.50', port: 80 }]));
    const first = await proxy.handleRequest({ id: 'dup', type: 'listMiners' });
    assert.equal(first.success, true);
    const second = await proxy.handleRequest({ id: 'dup', type: 'listMiners' });
    assert.equal(second.success, false);
    assert.match(second.error, /Duplicate/);
  });

  it('rejects a target the scanner never discovered', async () => {
    const proxy = new MinerProxy(fakeScanner([])); // empty cache, no-op rescan
    const resp = await proxy.handleRequest({
      id: 'a3', type: 'minerStatus', target: '192.168.1.77', minerProtocol: 'bitaxeHTTP',
    });
    assert.equal(resp.success, false);
    assert.match(resp.error, /not a miner discovered/);
  });

  it('rejects a structurally invalid target before any network call', async () => {
    const proxy = new MinerProxy(fakeScanner([]));
    const resp = await proxy.handleRequest({
      id: 'a4', type: 'minerStatus', target: '127.0.0.1:8080', minerProtocol: 'bitaxeHTTP',
    });
    assert.equal(resp.success, false);
    assert.match(resp.error, /Invalid miner target/);
  });

  it('bridgeInfo advertises minAppVersion 2', async () => {
    const proxy = new MinerProxy(fakeScanner([]));
    const resp = await proxy.handleRequest({ id: 'b1', type: 'bridgeInfo' });
    assert.equal(resp.data.value.minAppVersion, 2);
  });
});

// ---- Identity key (Ed25519, TOFU) ----

describe('BridgeCrypto identity', () => {
  it('generates a persistent identity that survives reload', () => {
    const id1 = bridgeCrypto.loadOrCreateIdentity();
    const id2 = bridgeCrypto.loadOrCreateIdentity();
    assert.equal(id1.publicKeyRaw.length, 32);
    assert.ok(id1.publicKeyRaw.equals(id2.publicKeyRaw), 'identity reused across loads');
    assert.equal(id1.fingerprint, id2.fingerprint);
  });

  it('fingerprint is 6 groups (48-bit), colon-hex', () => {
    const id = bridgeCrypto.loadOrCreateIdentity();
    const groups = id.fingerprint.split(':');
    assert.equal(groups.length, 6);
    for (const g of groups) assert.match(g, /^[0-9a-f]{2}$/);
  });

  it('signature over the ephemeral key verifies with the raw identity key', () => {
    const id = bridgeCrypto.loadOrCreateIdentity();
    const ephemeral = crypto.randomBytes(32);
    const sig = id.sign(ephemeral);
    assert.equal(sig.length, 64);
    // Reconstruct the public key from raw bytes the same way iOS does.
    const spki = Buffer.concat([bridgeCrypto.ED25519_SPKI_PREFIX, id.publicKeyRaw]);
    const pub = crypto.createPublicKey({ key: spki, format: 'der', type: 'spki' });
    assert.ok(crypto.verify(null, ephemeral, pub, sig));
    // A tampered ephemeral key must fail.
    assert.ok(!crypto.verify(null, crypto.randomBytes(32), pub, sig));
  });
});
