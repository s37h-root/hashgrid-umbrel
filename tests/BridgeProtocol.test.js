'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  EnvelopeType,
  RequestType,
  MinerProtocolType,
  createEnvelope,
  parseEnvelope,
  createResponse,
  createMinerListResponse,
  createMinerStatusResponse,
  createMinerActionResponse,
  createBridgeInfoResponse,
} = require('../bridge/BridgeProtocol');

describe('BridgeProtocol', () => {
  it('creates and parses a ping envelope', () => {
    const env = createEnvelope(EnvelopeType.PING, null);
    assert.deepStrictEqual(env, { type: 'ping', payload: null });
    const parsed = parseEnvelope(JSON.stringify(env));
    assert.equal(parsed.type, 'ping');
    assert.equal(parsed.payload, null);
  });

  it('creates and parses an encrypted envelope with base64 payload', () => {
    const data = Buffer.from('hello');
    const env = createEnvelope(EnvelopeType.ENCRYPTED, data);
    assert.equal(env.type, 'encrypted');
    assert.equal(env.payload, data.toString('base64'));
    const parsed = parseEnvelope(JSON.stringify(env));
    assert.equal(parsed.type, 'encrypted');
    assert.deepStrictEqual(Buffer.from(parsed.payload, 'base64'), data);
  });

  it('creates a minerList response', () => {
    const miners = [{ ip: '192.168.1.10', port: 80, minerProtocol: 'bitaxeHTTP', deviceModel: 'BitAxe Ultra', hostname: 'bitaxe-ultra' }];
    const resp = createMinerListResponse('req-1', miners);
    assert.equal(resp.id, 'req-1');
    assert.equal(resp.success, true);
    assert.equal(resp.data.type, 'minerList');
    assert.equal(resp.data.value.miners.length, 1);
    assert.equal(resp.data.value.miners[0].ip, '192.168.1.10');
  });

  it('creates a minerStatus response', () => {
    const raw = Buffer.from('{"hashRate":500}');
    const resp = createMinerStatusResponse('req-2', raw);
    assert.equal(resp.data.type, 'minerStatus');
    assert.equal(resp.data.value.rawJSON, raw.toString('base64'));
  });

  it('creates a minerAction response', () => {
    const resp = createMinerActionResponse('req-3', true, 'rebooted');
    assert.equal(resp.data.type, 'minerAction');
    assert.equal(resp.data.value.success, true);
    assert.equal(resp.data.value.message, 'rebooted');
  });

  it('creates a bridgeInfo response', () => {
    const resp = createBridgeInfoResponse('req-4', {
      version: '1.0.0',
      platform: 'umbrel',
      uptime: 120.5,
      minerCount: 3,
      hostname: 'umbrel.local',
    });
    assert.equal(resp.data.type, 'bridgeInfo');
    assert.equal(resp.data.value.platform, 'umbrel');
    assert.equal(resp.data.value.minerCount, 3);
  });

  it('creates an error response', () => {
    const resp = createResponse('req-5', false, 'something broke');
    assert.equal(resp.success, false);
    assert.equal(resp.error, 'something broke');
    assert.equal(resp.data, undefined);
  });
});
