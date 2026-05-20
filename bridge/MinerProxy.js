'use strict';

const http = require('node:http');
const net = require('node:net');
const crypto = require('node:crypto');
const {
  RequestType,
  createMinerListResponse,
  createMinerStatusResponse,
  createMinerActionResponse,
  createBridgeInfoResponse,
  createResponse,
} = require('./BridgeProtocol');

const CGMINER_PORT = 4028;
const CGMINER_TIMEOUT_MS = 3_000;
const BITAXE_STATUS_TIMEOUT_MS = 5_000;
const ANTMINER_TIMEOUT_MS = 10_000;
const BRIDGE_VERSION = '1.0.0';
const BRIDGE_PLATFORM = 'umbrel';

// Parse a target string into [host, port]. iOS sends "192.168.1.50:4029"
// for cgminer devices on non-default ports (e.g. Avalon Nano 3S in
// multi-miner setups). Without this, net.Socket.connect would treat the
// entire string as a hostname and fail to resolve.
function splitHostPort(target, defaultPort) {
  if (target.startsWith('[')) return [target, defaultPort];
  const colonIdx = target.lastIndexOf(':');
  if (colonIdx > 0) {
    const port = Number(target.slice(colonIdx + 1));
    if (Number.isInteger(port) && port > 0 && port < 65536) {
      return [target.slice(0, colonIdx), port];
    }
  }
  return [target, defaultPort];
}

// Legacy single-command builder retained for tests + the simple actions
// that still map 1:1 to a cgminer command. LED + pool actions fan out
// via dedicated functions below.
function buildCGMinerCommand(action, params) {
  switch (action) {
    case 'reboot':
      return { command: 'ascset', parameter: '0,reboot,1' };
    case 'restart':
      return { command: 'restart' };
    case 'softoff': {
      const epoch = params.epoch || String(Math.floor(Date.now() / 1000) + 10);
      return { command: 'ascset', parameter: `0,softoff,1:${epoch}` };
    }
    case 'softon': {
      const epoch = params.epoch || String(Math.floor(Date.now() / 1000) + 10);
      return { command: 'ascset', parameter: `0,softon,1:${epoch}` };
    }
    case 'setFrequency':
      return { command: 'ascset', parameter: `0,freq,${params.mhz}` };
    case 'setWorkMode':
      return { command: 'ascset', parameter: `0,workmode,${params.mode}` };
    case 'switchPool':
      return { command: 'switchpool', parameter: String(params.poolIndex || '0') };
    default:
      return { command: action };
  }
}

function sendCGMinerCommand(target, command) {
  return new Promise((resolve, reject) => {
    const [host, port] = splitHostPort(target, CGMINER_PORT);
    const socket = new net.Socket();
    let data = '';
    let settled = false;
    socket.setTimeout(CGMINER_TIMEOUT_MS);
    const payload = (typeof command === 'string') ? command : JSON.stringify(command);
    socket.connect(port, host, () => { socket.write(payload + '\n'); });
    socket.on('data', (chunk) => { data += chunk.toString(); });
    socket.on('end', () => { if (settled) return; settled = true; socket.destroy(); resolve(data.replace(/\0+$/, '')); });
    socket.on('close', () => { if (settled) return; settled = true; resolve(data.replace(/\0+$/, '')); });
    socket.on('error', (err) => { if (settled) return; settled = true; socket.destroy(); reject(err); });
    socket.on('timeout', () => { if (settled) return; settled = true; socket.destroy(); reject(new Error('timeout')); });
  });
}

// ---- LED + fan + pool builders (mirror iOS CGMinerClient wire format) ----

const clampInt = (v, lo, hi) => Math.min(hi, Math.max(lo, Math.trunc(Number(v) || 0)));

function parseHexColor(hex) {
  if (!hex) return null;
  const s = hex.startsWith('#') ? hex.slice(1) : hex;
  if (s.length !== 6) return null;
  const r = Number.parseInt(s.slice(0, 2), 16);
  const g = Number.parseInt(s.slice(2, 4), 16);
  const b = Number.parseInt(s.slice(4, 6), 16);
  if ([r, g, b].some(Number.isNaN)) return null;
  return [r, g, b];
}

// fan speed: -1 = smart-speed on + fan-spd -1; 0..100 = smart-speed off + fan-spd clamped 15..100
async function sendFanSpeed(target, speed) {
  const auto = Number(speed) === -1;
  try { await sendCGMinerCommand(target, `ascset|0,smart-speed,${auto ? 1 : 0}`); }
  catch { /* smart-speed unsupported on some Avalon models — keep going */ }
  const fanValue = auto ? -1 : clampInt(speed, 15, 100);
  await sendCGMinerCommand(target, `ascset|0,fan-spd,${fanValue}`);
}

async function sendLEDMode(target, mode, brightness, red, green, blue, isNano3S) {
  const eff = clampInt(mode, 0, 4);
  const br = clampInt(brightness, 0, 100);
  const r = clampInt(red, 0, 255);
  const g = clampInt(green, 0, 255);
  const b = clampInt(blue, 0, 255);
  if (isNano3S) {
    try { await sendCGMinerCommand(target, 'ascset|0,ledmode,0'); } catch { /* prereq best-effort */ }
    await sendCGMinerCommand(target, `ascset|0,ledset,${eff}-${br}-100-${r}-${g}-${b}`);
  } else {
    await sendCGMinerCommand(target, `ascset|0,led,setmode,${eff}`);
    if (eff > 0) {
      try { await sendCGMinerCommand(target, `ascset|0,led,setrgb,${br}-100-${r}-${g}-${b}`); } catch {}
    }
  }
}

async function sendLEDColor(target, brightness, red, green, blue, mode, isNano3S) {
  const eff = clampInt(mode, 0, 4);
  const br = clampInt(brightness, 0, 100);
  const r = clampInt(red, 0, 255);
  const g = clampInt(green, 0, 255);
  const b = clampInt(blue, 0, 255);
  if (isNano3S) {
    try { await sendCGMinerCommand(target, 'ascset|0,ledmode,0'); } catch {}
    await sendCGMinerCommand(target, `ascset|0,ledset,${eff}-${br}-100-${r}-${g}-${b}`);
  } else {
    await sendCGMinerCommand(target, `ascset|0,led,setrgb,${br}-100-${r}-${g}-${b}`);
  }
}

async function sendSetPool(target, poolIndex, url, worker, password, authUser, authPass) {
  const clamped = clampInt(poolIndex, 0, 2);
  const command = `setpool|${authUser},${authPass},${clamped},${url},${worker},${password}`;
  await sendCGMinerCommand(target, command);
}

async function sendRotatePools(target, params) {
  const targetIndex = clampInt(params.targetIndex, 0, 2);
  let poolsArr;
  try { poolsArr = JSON.parse(params.pools || '[]'); }
  catch { throw new Error('Invalid pools JSON'); }
  if (!Array.isArray(poolsArr) || poolsArr.length !== 3) {
    throw new Error('Pool rotation requires exactly 3 pools');
  }
  const authUser = params.authUser || 'admin';
  const authPass = params.authPass || 'admin';
  const order = [targetIndex];
  for (let i = 0; i < 3; i++) if (i !== targetIndex) order.push(i);
  for (let newSlot = 0; newSlot < order.length; newSlot++) {
    const pool = poolsArr[order[newSlot]] || {};
    const url = pool.url || '';
    const worker = pool.worker || '';
    const password = pool.password || '';
    if (!url || !worker) continue;
    await sendSetPool(target, newSlot, url, worker, password, authUser, authPass);
    await new Promise((res) => setTimeout(res, 200));
  }
}

// Single dispatcher for cgminer-protocol actions. LED/pool/fan fan out
// into multiple sendCGMinerCommand calls; everything else falls through
// to the single-command path so unknown actions throw cleanly instead
// of being passed straight to cgminer.
async function forwardCGMinerAction(target, action, params) {
  const p = params || {};
  switch (action) {
    case 'reboot':
    case 'restart':
    case 'softoff':
    case 'softon':
    case 'setFrequency':
    case 'setWorkMode':
    case 'switchPool':
      await sendCGMinerCommand(target, buildCGMinerCommand(action, p));
      return;
    case 'setFanSpeed':
      await sendFanSpeed(target, p.speed);
      return;
    case 'setLED': {
      const enabled = p.enabled === '1' || p.enabled === 1 || p.enabled === true;
      const isNano3S = (p.isNano3S ?? '1') !== '0';
      await sendLEDMode(target, enabled ? 1 : 0, 50, 255, 255, 255, isNano3S);
      return;
    }
    case 'setLEDMode':
      await sendLEDMode(
        target,
        clampInt(p.mode, 0, 4),
        clampInt(p.brightness ?? 50, 0, 100),
        clampInt(p.red ?? 255, 0, 255),
        clampInt(p.green ?? 255, 0, 255),
        clampInt(p.blue ?? 255, 0, 255),
        (p.isNano3S ?? '1') !== '0'
      );
      return;
    case 'setLEDColor':
      await sendLEDColor(
        target,
        clampInt(p.brightness ?? 50, 0, 100),
        clampInt(p.red ?? 255, 0, 255),
        clampInt(p.green ?? 255, 0, 255),
        clampInt(p.blue ?? 255, 0, 255),
        clampInt(p.mode ?? 1, 0, 4),
        (p.isNano3S ?? '1') !== '0'
      );
      return;
    case 'setLEDRGB': {
      const rgb = parseHexColor(p.hexColor);
      if (!rgb) throw new Error('Invalid hexColor');
      await sendLEDColor(
        target,
        clampInt(p.brightness ?? 50, 0, 100),
        rgb[0], rgb[1], rgb[2],
        1,
        (p.isNano3S ?? '1') !== '0'
      );
      return;
    }
    case 'configurePool': {
      const idx = clampInt(p.poolIndex, 0, 2);
      const url = p.url, worker = p.worker, password = p.password;
      if (!url || !worker || password === undefined) throw new Error('Missing pool fields');
      const authUser = p.authUser || 'admin';
      const authPass = p.authPass || 'admin';
      await sendSetPool(target, idx, url, worker, password, authUser, authPass);
      return;
    }
    case 'rotatePools':
      await sendRotatePools(target, p);
      return;
    default:
      throw new Error(`Unknown cgminer action: ${action}`);
  }
}

// ---- Antminer CGI: HTTP Digest auth to /cgi-bin/set_miner_conf.cgi ----

function md5(s) { return crypto.createHash('md5').update(s).digest('hex'); }

// Parse a WWW-Authenticate: Digest header into key/value pairs.
function parseDigestChallenge(header) {
  const result = {};
  // Strip the leading "Digest " then split on commas not inside quotes.
  const body = header.replace(/^Digest\s+/i, '');
  const re = /(\w+)\s*=\s*(?:"([^"]*)"|([^,]*))/g;
  let m;
  while ((m = re.exec(body)) !== null) {
    result[m[1]] = (m[2] !== undefined) ? m[2] : (m[3] || '').trim();
  }
  return result;
}

function buildDigestAuthHeader(challenge, method, uri, username, password) {
  const realm = challenge.realm || '';
  const nonce = challenge.nonce || '';
  const qop = challenge.qop || 'auth';
  const opaque = challenge.opaque;
  const cnonce = crypto.randomBytes(8).toString('hex');
  const nc = '00000001';
  const ha1 = md5(`${username}:${realm}:${password}`);
  const ha2 = md5(`${method}:${uri}`);
  const response = md5(`${ha1}:${nonce}:${nc}:${cnonce}:${qop}:${ha2}`);
  let header = `Digest username="${username}", realm="${realm}", nonce="${nonce}", uri="${uri}", qop=${qop}, nc=${nc}, cnonce="${cnonce}", response="${response}"`;
  if (opaque) header += `, opaque="${opaque}"`;
  return header;
}

function antminerHttpRequest(host, port, path, method, body, headers) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: host, port, path, method,
      headers: { ...headers, 'Content-Length': body ? Buffer.byteLength(body) : 0 },
      timeout: ANTMINER_TIMEOUT_MS,
    }, (res) => {
      let respBody = '';
      res.on('data', (chunk) => { respBody += chunk; });
      res.on('end', () => resolve({ statusCode: res.statusCode, headers: res.headers, body: respBody }));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    if (body) req.write(body);
    req.end();
  });
}

async function sendAntminerPoolConfig(target, params) {
  const p = params || {};
  let poolsArr;
  try { poolsArr = JSON.parse(p.pools || '[]'); }
  catch { throw new Error('Invalid pools JSON'); }
  if (!Array.isArray(poolsArr) || poolsArr.length === 0) throw new Error('No pools provided');

  const username = p.username || 'root';
  const password = p.password || 'admin';
  const [host, port] = splitHostPort(target, 80);
  const path = '/cgi-bin/set_miner_conf.cgi';
  const payload = JSON.stringify({
    pools: poolsArr.map((x) => ({ url: x.url || '', user: x.user || '', pass: x.pass || '' })),
  });

  // First request — expect a 401 with Digest challenge.
  const first = await antminerHttpRequest(host, port, path, 'POST', payload, {
    'Content-Type': 'application/json',
  });
  if (first.statusCode >= 200 && first.statusCode < 300) return; // Some firmware accepts no auth.
  if (first.statusCode !== 401) throw new Error(`Antminer CGI HTTP ${first.statusCode}`);
  const wwwAuth = first.headers['www-authenticate'];
  if (!wwwAuth || !/^Digest\s/i.test(wwwAuth)) throw new Error('Antminer did not request Digest auth');

  const challenge = parseDigestChallenge(wwwAuth);
  const authHeader = buildDigestAuthHeader(challenge, 'POST', path, username, password);
  const second = await antminerHttpRequest(host, port, path, 'POST', payload, {
    'Content-Type': 'application/json',
    Authorization: authHeader,
  });
  if (second.statusCode === 401) throw new Error('Invalid Antminer credentials');
  if (second.statusCode < 200 || second.statusCode >= 300) {
    throw new Error(`Antminer CGI HTTP ${second.statusCode}`);
  }
}

function fetchBitAxeStatus(target) {
  return new Promise((resolve, reject) => {
    const [host, port] = splitHostPort(target, 80);
    const req = http.get({
      hostname: host, port, path: '/api/system/info', timeout: BITAXE_STATUS_TIMEOUT_MS,
    }, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => resolve(body));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
  });
}

async function fetchCGMinerStatus(ip) {
  const commands = ['summary', 'devs', 'pools', 'version', 'stats'];
  const result = {};
  for (const cmd of commands) {
    try {
      const response = await sendCGMinerCommand(ip, { command: cmd });
      result[cmd] = Buffer.from(response).toString('base64');
    } catch {
      if (cmd !== 'stats') { result[cmd] = ''; }
    }
  }
  return result;
}

function sendBitAxeAction(target, action, params) {
  return new Promise((resolve, reject) => {
    const [host, port] = splitHostPort(target, 80);
    const postData = JSON.stringify(params || {});
    const req = http.request({
      hostname: host, port, path: `/api/system/${action}`, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(postData) },
      timeout: CGMINER_TIMEOUT_MS,
    }, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => resolve(body));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.write(postData);
    req.end();
  });
}

class MinerProxy {
  constructor(scanner) {
    this.scanner = scanner;
    this.startTime = Date.now();
  }

  async handleRequest(request) {
    try {
      switch (request.type) {
        case RequestType.LIST_MINERS:
          return createMinerListResponse(request.id, this.scanner.miners);
        case RequestType.MINER_STATUS:
          return await this._handleMinerStatus(request);
        case RequestType.MINER_ACTION:
          return await this._handleMinerAction(request);
        case RequestType.BRIDGE_INFO:
          return this._handleBridgeInfo(request);
        case RequestType.UNPAIR:
          return createResponse(request.id, true);
        default:
          return createResponse(request.id, false, `Unknown request type: ${request.type}`);
      }
    } catch (err) {
      return createResponse(request.id, false, err.message);
    }
  }

  async _handleMinerStatus(request) {
    const ip = request.target;
    if (!ip) return createResponse(request.id, false, 'No target IP');
    const protocol = request.minerProtocol || 'bitaxeHTTP';
    if (protocol === 'bitaxeHTTP') {
      const raw = await fetchBitAxeStatus(ip);
      return createMinerStatusResponse(request.id, Buffer.from(raw));
    }
    const envelope = await fetchCGMinerStatus(ip);
    return createMinerStatusResponse(request.id, Buffer.from(JSON.stringify(envelope)));
  }

  async _handleMinerAction(request) {
    const ip = request.target;
    if (!ip) return createResponse(request.id, false, 'No target IP');
    const action = request.action;
    if (!action) return createResponse(request.id, false, 'No action specified');
    const params = request.parameters || {};
    const protocol = request.minerProtocol || 'bitaxeHTTP';
    if (protocol === 'bitaxeHTTP') {
      await sendBitAxeAction(ip, action, params);
      return createMinerActionResponse(request.id, true, null);
    }
    if (protocol === 'antminerCGI') {
      if (action !== 'configureAntminerPools') {
        return createResponse(request.id, false, `Unknown Antminer action: ${action}`);
      }
      await sendAntminerPoolConfig(ip, params);
      return createMinerActionResponse(request.id, true, null);
    }
    // cgminerTCP — single dispatcher handles LED, fan, pool, etc.
    await forwardCGMinerAction(ip, action, params);
    return createMinerActionResponse(request.id, true, null);
  }

  _handleBridgeInfo(request) {
    const os = require('node:os');
    return createBridgeInfoResponse(request.id, {
      version: BRIDGE_VERSION,
      platform: BRIDGE_PLATFORM,
      uptime: (Date.now() - this.startTime) / 1000,
      minerCount: this.scanner.miners.length,
      hostname: os.hostname(),
    });
  }
}

module.exports = {
  MinerProxy,
  buildCGMinerCommand,
  sendCGMinerCommand,
  fetchBitAxeStatus,
  fetchCGMinerStatus,
  splitHostPort,
  forwardCGMinerAction,
  sendAntminerPoolConfig,
  parseDigestChallenge,
  buildDigestAuthHeader,
};
