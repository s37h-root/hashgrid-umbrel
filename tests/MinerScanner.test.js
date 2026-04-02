'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { detectSubnet, parseBitAxeInfo, parseCGMinerVersion } = require('../bridge/MinerScanner');

describe('MinerScanner', () => {
  it('parseBitAxeInfo identifies a BitAxe by ASICModel', () => {
    const result = parseBitAxeInfo({ ASICModel: 'BM1366', hostname: 'bitaxe-ultra' });
    assert.equal(result.deviceModel, 'BM1366');
    assert.equal(result.hostname, 'bitaxe-ultra');
  });

  it('parseBitAxeInfo identifies a BitAxe by boardVersion', () => {
    const result = parseBitAxeInfo({ boardVersion: '402' });
    assert.equal(result.deviceModel, '402');
  });

  it('parseBitAxeInfo identifies by hashRate + freeHeap', () => {
    const result = parseBitAxeInfo({ hashRate: 500, freeHeap: 100000 });
    assert.equal(result.deviceModel, 'BitAxe');
  });

  it('parseBitAxeInfo returns null for non-miner', () => {
    const result = parseBitAxeInfo({ title: 'My Router' });
    assert.equal(result, null);
  });

  it('parseCGMinerVersion extracts model from PROD field', () => {
    const data = { VERSION: [{ PROD: 'AvalonMiner nano3s' }] };
    assert.equal(parseCGMinerVersion(data), 'AvalonMiner nano3s');
  });

  it('parseCGMinerVersion extracts model from MODEL field', () => {
    const data = { VERSION: [{ MODEL: 'Antminer S19' }] };
    assert.equal(parseCGMinerVersion(data), 'Antminer S19');
  });

  it('parseCGMinerVersion extracts model from Type field', () => {
    const data = { VERSION: [{ Type: 'Whatsminer M50' }] };
    assert.equal(parseCGMinerVersion(data), 'Whatsminer M50');
  });

  it('parseCGMinerVersion extracts model from Miner field', () => {
    const data = { VERSION: [{ Miner: 'cgminer 4.12' }] };
    assert.equal(parseCGMinerVersion(data), 'cgminer 4.12');
  });

  it('parseCGMinerVersion returns default for empty VERSION', () => {
    const data = { VERSION: [{}] };
    assert.equal(parseCGMinerVersion(data), 'CGMiner Device');
  });

  it('parseCGMinerVersion returns null for invalid data', () => {
    assert.equal(parseCGMinerVersion({}), null);
    assert.equal(parseCGMinerVersion({ VERSION: [] }), null);
  });
});
