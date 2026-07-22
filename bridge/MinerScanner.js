'use strict';

const os = require('node:os');
const net = require('node:net');
const http = require('node:http');

const SCAN_CONCURRENCY = 12;
const SCAN_INTERVAL_MS = 30_000;
const PROBE_TIMEOUT_MS = 1_000;
const BITAXE_PORT = 80;
const CGMINER_PORT = 4028;

function detectSubnet() {
  const interfaces = os.networkInterfaces();
  for (const [name, addrs] of Object.entries(interfaces)) {
    if (name === 'lo' || name === 'lo0') continue;
    for (const addr of addrs) {
      if (addr.family !== 'IPv4' || addr.internal) continue;
      const ip = addr.address;
      if (ip.startsWith('192.168.') || ip.startsWith('10.') || isPrivate172(ip)) {
        const parts = ip.split('.');
        return `${parts[0]}.${parts[1]}.${parts[2]}`;
      }
    }
  }
  return null;
}

function isPrivate172(ip) {
  if (!ip.startsWith('172.')) return false;
  const second = parseInt(ip.split('.')[1], 10);
  return second >= 16 && second <= 31;
}

// Format a BitAxe-family device's friendly product name EXACTLY as the HashGrid
// app does at discovery (NetworkManager+Discovery.formatBitaxeHardwareType): use
// an explicit device model if the firmware reports one, else map boardVersion to
// a board name, then apply the brand prefix / Hammer / NerdQAxe handling — so the
// bridge's labels read identically to the app's discovery badges ("Bitaxe Gamma",
// "GammaTurbo", "NerdQAxe++", "Hammer Miner", ...).
function formatBitaxeHardwareType(data) {
  // Mirror MinerApiResponse.deviceModel derivation (first non-empty of these).
  let model = data.deviceModel || data.device_model || data.model || data.DeviceModel || data.product || null;
  if (model === '' || model === 'N/A') model = null;

  // Fallback: infer the board model from boardVersion (BitAxe-specific).
  if (model == null && data.boardVersion != null) {
    const b = String(data.boardVersion);
    if (b.startsWith('80') || b.includes('800') || b.includes('801') || b.includes('802') || b.includes('803')) model = 'GammaTurbo';
    else if (b.startsWith('70') || b.includes('700') || b.includes('701')) model = 'Supra';
    else if (b.startsWith('60') || b.includes('601') || b.includes('602') || b.includes('603')) model = 'Gamma';
    else if (b.startsWith('40') || b.includes('401')) model = 'Ultra';
    else if (b.startsWith('20') || b.includes('204')) model = 'Max';
    else if (b.startsWith('30') || b.includes('303')) model = 'Hex';
  }

  if (model != null) {
    const lm = model.toLowerCase();
    if (lm.startsWith('dc0')) return 'Hammer Miner';                          // Hammer (DC02/DC04/DC06)
    if (lm.includes('bitaxe') || lm.includes('nerd') || lm.includes('qaxe')) return model; // already branded
    return 'Bitaxe ' + model;                                                // standard BitAxe boards
  }

  return data.hostname || null;
}

function parseBitAxeInfo(data) {
  // Confirm it's a BitAxe-family (ESP-Miner) device before labeling it.
  const looksBitaxe = data.ASICModel || data.boardVersion != null ||
    (data.hashRate != null && data.freeHeap != null);
  if (!looksBitaxe) return null;
  return {
    deviceModel: formatBitaxeHardwareType(data) || 'BitAxe',
    hostname: data.hostname || null,
  };
}

function parseCGMinerVersion(data) {
  if (!data.VERSION || !Array.isArray(data.VERSION) || data.VERSION.length === 0) return null;
  const v = data.VERSION[0];
  return v.PROD || v.MODEL || v.Type || v.Miner || 'CGMiner Device';
}

function probeBitAxe(ip) {
  return new Promise((resolve) => {
    const req = http.get(`http://${ip}/api/system/info`, { timeout: PROBE_TIMEOUT_MS }, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        try {
          const data = JSON.parse(body);
          const result = parseBitAxeInfo(data);
          if (result) {
            resolve({ ip, port: BITAXE_PORT, minerProtocol: 'bitaxeHTTP', deviceModel: result.deviceModel, hostname: result.hostname });
          } else {
            resolve(null);
          }
        } catch { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
  });
}

function probeCGMiner(ip) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let data = '';
    socket.setTimeout(PROBE_TIMEOUT_MS);
    socket.connect(CGMINER_PORT, ip, () => { socket.write('{"command":"version"}\n'); });
    socket.on('data', (chunk) => { data += chunk.toString(); });
    socket.on('end', () => {
      socket.destroy();
      try {
        const cleaned = data.replace(/\0+$/, '');
        const parsed = JSON.parse(cleaned);
        const model = parseCGMinerVersion(parsed);
        if (model) { resolve({ ip, port: CGMINER_PORT, minerProtocol: 'cgminerTCP', deviceModel: model, hostname: null }); }
        else { resolve(null); }
      } catch { resolve(null); }
    });
    socket.on('error', () => { socket.destroy(); resolve(null); });
    socket.on('timeout', () => { socket.destroy(); resolve(null); });
  });
}

async function probeIP(ip) {
  const [cgminer, bitaxe] = await Promise.all([probeCGMiner(ip), probeBitAxe(ip)]);
  return cgminer || bitaxe;
}

async function scanSubnet(subnetPrefix) {
  const miners = [];
  const ips = [];
  for (let i = 1; i <= 254; i++) { ips.push(`${subnetPrefix}.${i}`); }
  let index = 0;
  const workers = Array.from({ length: SCAN_CONCURRENCY }, async () => {
    while (index < ips.length) {
      const ip = ips[index++];
      const result = await probeIP(ip);
      if (result) miners.push(result);
    }
  });
  await Promise.all(workers);
  miners.sort((a, b) => {
    const aParts = a.ip.split('.').map(Number);
    const bParts = b.ip.split('.').map(Number);
    for (let i = 0; i < 4; i++) { if (aParts[i] !== bParts[i]) return aParts[i] - bParts[i]; }
    return 0;
  });
  return miners;
}

class MinerScanner {
  constructor() {
    this.miners = [];
    this.customSubnet = null;
    this._timer = null;
    this._scanning = false;
  }

  setCustomSubnet(prefix) { this.customSubnet = prefix || null; }
  getSubnet() { return this.customSubnet || detectSubnet(); }

  async scan() {
    if (this._scanning) return;
    this._scanning = true;
    try {
      const subnet = this.getSubnet();
      if (!subnet) { this.miners = []; return; }
      this.miners = await scanSubnet(subnet);
    } finally { this._scanning = false; }
  }

  start() {
    this.scan();
    this._timer = setInterval(() => this.scan(), SCAN_INTERVAL_MS);
  }

  stop() {
    if (this._timer) { clearInterval(this._timer); this._timer = null; }
  }
}

module.exports = { MinerScanner, detectSubnet, parseBitAxeInfo, parseCGMinerVersion, probeBitAxe, probeCGMiner, probeIP, scanSubnet };
