'use strict';

// Pure miner-stat extraction for the Live Activity fleet summary.
// Scope (first slice): BitAxe HTTP fully; cgminer hashrate + best-effort temp.
// Per-device temp key coverage is intentionally iterative — extend TEMP_KEYS as
// new device families are validated on-device.

const TEMP_KEYS = ['TMax', 'Temp', 'temp', 'Temperature', 'TAvg', 'temp1', 'temp2_1'];

function _b64json(s) {
  try { return JSON.parse(Buffer.from(s, 'base64').toString('utf8')); }
  catch { return null; }
}

function _parseBitAxe(bodyStr) {
  let obj;
  try { obj = JSON.parse(bodyStr); } catch { return { online: false, hashrateGH: 0, tempC: null }; }
  if (!obj || typeof obj.hashRate !== 'number') return { online: false, hashrateGH: 0, tempC: null };
  const tempC = typeof obj.temp === 'number' ? obj.temp : null;
  return { online: true, hashrateGH: obj.hashRate, tempC };
}

function _parseCGMiner(raw) {
  if (!raw || typeof raw !== 'object') return { online: false, hashrateGH: 0, tempC: null };
  const summary = raw.summary ? _b64json(raw.summary) : null;
  const s0 = summary && Array.isArray(summary.SUMMARY) ? summary.SUMMARY[0] : null;
  if (!s0) return { online: false, hashrateGH: 0, tempC: null };

  let hashrateGH = 0;
  if (typeof s0['GHS 5s'] === 'number') hashrateGH = s0['GHS 5s'];
  else if (typeof s0['GHS av'] === 'number') hashrateGH = s0['GHS av'];
  else if (typeof s0['MHS av'] === 'number') hashrateGH = s0['MHS av'] / 1000;

  let tempC = null;
  const stats = raw.stats ? _b64json(raw.stats) : null;
  const st0 = stats && Array.isArray(stats.STATS) ? stats.STATS.find(x => TEMP_KEYS.some(k => typeof x[k] === 'number')) : null;
  if (st0) { for (const k of TEMP_KEYS) { if (typeof st0[k] === 'number') { tempC = st0[k]; break; } } }

  return { online: true, hashrateGH, tempC };
}

function parseMinerStats(minerProtocol, raw) {
  if (minerProtocol === 'bitaxeHTTP') return _parseBitAxe(typeof raw === 'string' ? raw : '');
  if (minerProtocol === 'cgminerTCP') return _parseCGMiner(raw);
  return { online: false, hashrateGH: 0, tempC: null };
}

const APPLE_EPOCH_OFFSET = 978307200; // seconds between 1970-01-01 and 2001-01-01
const HIGH_TEMP_C = 75;

function aggregateFleet(perMinerStats) {
  let totalHashrateGH = 0, onlineCount = 0, standbyCount = 0, offlineCount = 0;
  let tempSum = 0, tempN = 0;
  for (const m of perMinerStats) {
    if (!m.online) { offlineCount++; continue; }
    totalHashrateGH += m.hashrateGH;
    if (m.hashrateGH > 0) {
      onlineCount++;
      if (typeof m.tempC === 'number') { tempSum += m.tempC; tempN++; }
    } else { standbyCount++; }
  }
  const avgTemperatureC = tempN > 0 ? tempSum / tempN : 0;
  return {
    totalHashrateGH, onlineCount, standbyCount, offlineCount,
    avgTemperatureC, isHighTemperature: avgTemperatureC >= HIGH_TEMP_C,
  };
}

function formatHashrate(gh) {
  if (gh >= 1000) return `${(gh / 1000).toFixed(2)} TH/s`;
  return `${Math.round(gh)} GH/s`;
}

function buildContentState(fleet, sparklineSamples, nowMs) {
  return {
    totalHashrateGH: fleet.totalHashrateGH,
    hashrateDisplay: formatHashrate(fleet.totalHashrateGH),
    onlineCount: fleet.onlineCount,
    standbyCount: fleet.standbyCount,
    offlineCount: fleet.offlineCount,
    avgTemperatureC: fleet.avgTemperatureC,
    isHighTemperature: fleet.isHighTemperature,
    sparklineSamples: sparklineSamples.slice(-20),
    lastUpdated: Math.floor(nowMs / 1000) - APPLE_EPOCH_OFFSET,
  };
}

module.exports = { parseMinerStats, aggregateFleet, formatHashrate, buildContentState };
