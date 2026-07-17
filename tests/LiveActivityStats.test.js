'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { parseMinerStats } = require('../bridge/LiveActivityStats');

describe('parseMinerStats', () => {
  it('parses a BitAxe /api/system/info body (GH/s + temp)', () => {
    const body = JSON.stringify({ hashRate: 485.2, temp: 55.5, power: 15 });
    const s = parseMinerStats('bitaxeHTTP', body);
    assert.equal(s.online, true);
    assert.ok(Math.abs(s.hashrateGH - 485.2) < 0.001);
    assert.equal(s.tempC, 55.5);
  });

  it('marks a BitAxe with zero hashrate as standby-eligible (online but not hashing)', () => {
    const s = parseMinerStats('bitaxeHTTP', JSON.stringify({ hashRate: 0, temp: 40 }));
    assert.equal(s.online, true);
    assert.equal(s.hashrateGH, 0);
  });

  it('returns offline for unparseable/empty input', () => {
    assert.deepEqual(parseMinerStats('bitaxeHTTP', ''), { online: false, hashrateGH: 0, tempC: null });
    assert.deepEqual(parseMinerStats('cgminerTCP', {}), { online: false, hashrateGH: 0, tempC: null });
  });

  it('parses cgminer summary GHS 5s + stats temp', () => {
    const b64 = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64');
    const raw = {
      summary: b64({ SUMMARY: [{ 'GHS 5s': 13500.0, 'MHS av': 13400000 }] }),
      stats: b64({ STATS: [{ TMax: 72, TAvg: 65 }] }),
    };
    const s = parseMinerStats('cgminerTCP', raw);
    assert.equal(s.online, true);
    assert.ok(Math.abs(s.hashrateGH - 13500) < 0.001);
    assert.equal(s.tempC, 72);
  });

  it('falls back to MHS av when GHS 5s absent', () => {
    const b64 = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64');
    const raw = { summary: b64({ SUMMARY: [{ 'MHS av': 500000 }] }) };
    const s = parseMinerStats('cgminerTCP', raw);
    assert.ok(Math.abs(s.hashrateGH - 500) < 0.001); // 500000 MH/s = 500 GH/s
  });
});

const { aggregateFleet, formatHashrate, buildContentState } = require('../bridge/LiveActivityStats');

describe('aggregateFleet', () => {
  it('counts online/standby/offline and averages temp over hashing miners', () => {
    const f = aggregateFleet([
      { online: true, hashrateGH: 500, tempC: 60 },
      { online: true, hashrateGH: 0, tempC: 30 },     // standby
      { online: false, hashrateGH: 0, tempC: null },  // offline
      { online: true, hashrateGH: 1500, tempC: 80 },
    ]);
    assert.equal(f.onlineCount, 2);
    assert.equal(f.standbyCount, 1);
    assert.equal(f.offlineCount, 1);
    assert.equal(f.totalHashrateGH, 2000);
    assert.equal(f.avgTemperatureC, 70); // (60+80)/2, standby/offline excluded
    assert.equal(f.isHighTemperature, false);
  });

  it('flags high temperature at/above 75', () => {
    const f = aggregateFleet([{ online: true, hashrateGH: 100, tempC: 78 }]);
    assert.equal(f.isHighTemperature, true);
  });
});

describe('formatHashrate', () => {
  it('scales to TH/s above 1000 GH', () => { assert.equal(formatHashrate(1230), '1.23 TH/s'); });
  it('shows GH/s below 1000', () => { assert.equal(formatHashrate(485), '485 GH/s'); });
});

describe('buildContentState', () => {
  it('emits exact iOS keys and Apple-reference-date lastUpdated', () => {
    const fleet = { totalHashrateGH: 2000, onlineCount: 2, standbyCount: 0, offlineCount: 0, avgTemperatureC: 70, isHighTemperature: false };
    const cs = buildContentState(fleet, [1, 2, 3], 1_700_000_000_000);
    assert.deepEqual(Object.keys(cs).sort(), [
      'avgTemperatureC','hashrateDisplay','isHighTemperature','lastUpdated',
      'offlineCount','onlineCount','sparklineSamples','standbyCount','totalHashrateGH',
    ]);
    assert.equal(cs.totalHashrateGH, 2000);
    assert.equal(cs.hashrateDisplay, '2.00 TH/s');
    assert.equal(cs.lastUpdated, 1_700_000_000 - 978307200); // seconds since 2001
    assert.deepEqual(cs.sparklineSamples, [1, 2, 3]);
  });
});
