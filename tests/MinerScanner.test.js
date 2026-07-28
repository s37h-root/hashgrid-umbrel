'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { detectSubnet, parseBitAxeInfo, parseCGMinerVersion } = require('../bridge/MinerScanner');

describe('MinerScanner', () => {
  // `deviceModel` is a BRANDED display name, not a raw identifier. It mirrors the
  // iOS app's MinerApiResponse.deviceModel derivation so both surfaces label a
  // device identically. These two tests asserted the pre-branding contract and
  // went stale when formatBitaxeHardwareType landed in 9028cb5.

  it('parseBitAxeInfo identifies a BitAxe by ASICModel, naming it from the hostname', () => {
    const result = parseBitAxeInfo({ ASICModel: 'BM1366', hostname: 'bitaxe-ultra' });
    // ASICModel proves it IS a BitAxe but is not part of the deviceModel
    // derivation (the iOS side doesn't use it either), so the name falls through
    // to the hostname.
    assert.equal(result.deviceModel, 'bitaxe-ultra');
    assert.equal(result.hostname, 'bitaxe-ultra');
  });

  it('parseBitAxeInfo maps boardVersion to a branded board name', () => {
    assert.equal(parseBitAxeInfo({ boardVersion: '402' }).deviceModel, 'Bitaxe Ultra');
    assert.equal(parseBitAxeInfo({ boardVersion: '601' }).deviceModel, 'Bitaxe Gamma');
    assert.equal(parseBitAxeInfo({ boardVersion: '801' }).deviceModel, 'Bitaxe GammaTurbo');
  });

  it('parseBitAxeInfo does not double-brand an already-branded model', () => {
    assert.equal(parseBitAxeInfo({ boardVersion: '402', deviceModel: 'NerdQAxe+' }).deviceModel, 'NerdQAxe+');
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
