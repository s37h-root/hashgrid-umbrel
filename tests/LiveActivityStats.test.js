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
