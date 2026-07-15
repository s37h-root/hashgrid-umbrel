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
const BRIDGE_VERSION = '1.0.5';
const BRIDGE_PLATFORM = 'umbrel';
// App compatibility version the bridge requires (advertised in bridgeInfo).
// Legacy apps that can't send `issuedAt` get told to update via this gate.
const MIN_APP_VERSION = 2;

// Replay/freshness (spec §2).
const SEEN_ID_TTL_MS = 600_000;   // 10 min
const SEEN_ID_MAX = 2_000;
const ACTION_FRESHNESS_SEC = 120; // clock-skew tolerance for minerAction

// SSRF structural allowlist (spec §3 Layer A).
const ALLOWED_PORTS = new Set([80, 443, 4028, 4029]);

// Layer A — structural target validation, always on. `target` must be an IPv4
// literal (optionally `:port`) in an RFC-1918 private range, port restricted to
// known miner ports. Rejects DNS names (an internet-SSRF primitive), loopback,
// link-local (cloud metadata), public IPs, paths, `@`, and whitespace. Returns
// { host, port|null } or throws.
function validateTarget(target) {
  if (typeof target !== 'string' || target.length === 0) throw new Error('Invalid miner target');
  // Only ASCII digits, dots and one port separator are ever legitimate — this
  // rejects `/`, `?`, `#`, `@`, whitespace and hostnames outright.
  if (!/^[0-9.:]+$/.test(target)) throw new Error('Invalid miner target');

  const pieces = target.split(':');
  let host;
  let port = null;
  if (pieces.length === 1) {
    host = pieces[0];
  } else if (pieces.length === 2) {
    host = pieces[0];
    const p = Number(pieces[1]);
    if (!Number.isInteger(p) || !ALLOWED_PORTS.has(p)) throw new Error('Invalid miner target');
    port = p;
  } else {
    throw new Error('Invalid miner target');
  }

  const octets = parseIPv4(host);
  if (!octets || !isPrivateIPv4(octets)) throw new Error('Invalid miner target');
  return { host, port };
}

function parseIPv4(s) {
  const parts = s.split('.');
  if (parts.length !== 4) return null;
  const octets = [];
  for (const part of parts) {
    if (part.length < 1 || part.length > 3 || !/^[0-9]+$/.test(part)) return null;
    const v = Number(part);
    if (v > 255) return null;
    octets.push(v);
  }
  return octets;
}

// RFC 1918 only: 10/8, 172.16/12, 192.168/16. Everything else — loopback 127/8,
// link-local 169.254/16, 0.0.0.0, multicast, public — is rejected.
function isPrivateIPv4(o) {
  if (o[0] === 10) return true;
  if (o[0] === 172 && o[1] >= 16 && o[1] <= 31) return true;
  if (o[0] === 192 && o[1] === 168) return true;
  return false;
}

// Layer D — free-form values interpolated into cgminer command text (pool url,
// worker, password, auth credentials) must not be able to inject extra fields
// or commands: reject `,` `|` `"` `\` and control characters.
function validateFreeform(value, name) {
  const s = String(value);
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 0x2c /*,*/ || c === 0x7c /*|*/ || c === 0x22 /*"*/ || c === 0x5c /*\\*/ || c < 0x20 || c === 0x7f) {
      throw new Error(`Invalid value for parameter '${name}'`);
    }
  }
  return s;
}

// Numeric params (Layer D): must parse as an integer, else reject.
function requireInt(value, name) {
  const n = Number(value);
  if (!Number.isInteger(n)) throw new Error(`Invalid value for parameter '${name}'`);
  return n;
}

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

// Build the wire payload for a single-shot cgminer action. Nano 3S firmware
// requires the RAW pipe form (`ascset|0,X,Y`) for ascset commands — the
// JSON-wrapped form the bridge used pre-v1.0.4 was rejected silently. Every
// action here now mirrors the exact LAN wire format from CGMinerClient.swift.
function buildCGMinerCommand(action, params) {
  switch (action) {
    case 'reboot':
      // LAN: ascset|0,reboot,0 (Nano 3S/Q). The trailing 0 is the module id;
      // 1 worked on some firmware but 0 matches the LAN client.
      return 'ascset|0,reboot,0';
    case 'restart':
      // No ascset — standard cgminer restart command. JSON-wrap is fine.
      return { command: 'restart' };
    case 'softoff': {
      // Layer D: epoch is interpolated into the pipe command — must be integer.
      const epoch = params.epoch !== undefined ? requireInt(params.epoch, 'epoch') : Math.floor(Date.now() / 1000) + 10;
      // LAN: ascset|0,softoff,1:<epoch>
      return `ascset|0,softoff,1:${epoch}`;
    }
    case 'softon': {
      const epoch = params.epoch !== undefined ? requireInt(params.epoch, 'epoch') : Math.floor(Date.now() / 1000) + 10;
      // LAN: ascset|0,softon,1:<epoch>
      return `ascset|0,softon,1:${epoch}`;
    }
    case 'setFrequency':
      // LAN: ascset|0,frequency,<mhz>. The shorthand `freq` keyword was wrong.
      return `ascset|0,frequency,${requireInt(params.mhz, 'mhz')}`;
    case 'setWorkMode':
      // LAN: ascset|0,workmode,set,<mode> — the `set,` keyword is required.
      return `ascset|0,workmode,set,${requireInt(params.mode, 'mode')}`;
    case 'switchPool':
      // Standard cgminer switchpool — JSON-wrap is fine, no pipe needed.
      return { command: 'switchpool', parameter: String(requireInt(params.poolIndex ?? 0, 'poolIndex')) };
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
  // Layer D: every free-form field is interpolated into the command text, so
  // reject any value that could inject extra fields (`,` `|` etc.).
  validateFreeform(url, 'url');
  validateFreeform(worker, 'worker');
  validateFreeform(password, 'password');
  validateFreeform(authUser, 'authUser');
  validateFreeform(authPass, 'authPass');
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
  const raw = {};
  for (const cmd of commands) {
    try {
      const response = await sendCGMinerCommand(ip, { command: cmd });
      result[cmd] = Buffer.from(response).toString('base64');
      raw[cmd] = response;
    } catch {
      if (cmd !== 'stats') { result[cmd] = ''; }
    }
  }

  // Avalon Q failover: its primary `stats` response can carry an empty
  // "MM ID0" (cold start), which the app parses to nil stats. Mirror the iOS
  // LAN ladder bridge-side: when stats has no usable MM ID0 on a non-Antminer
  // device, run estats (then litestats) and attach the raw responses as extra
  // envelope fields for the app's failover parser. Skipped for Antminers and
  // healthy Avalons — normal poll cost unchanged.
  if (needsAvalonStatsFailover(raw.stats, raw.version)) {
    for (const cmd of ['estats', 'litestats']) {
      try {
        const response = await sendCGMinerCommand(ip, { command: cmd });
        result[cmd] = Buffer.from(response).toString('base64');
        // The app's failover parser needs a non-empty "MM ID0:Summary";
        // stop the ladder once one is in hand.
        if (hasUsableMMIDSummary(response)) { break; }
      } catch {
        // Try the next failover command.
      }
    }
  }

  return result;
}

// True when the primary `stats` blob would parse to nil Avalon stats on iOS
// (no non-empty "MM ID0"/"MM ID0:Summary" value). Antminers (BMMiner field /
// "antminer" in version) never need the Avalon ladder.
function needsAvalonStatsFailover(stats, version) {
  if (version) {
    const vText = version.toString('utf8');
    if (vText.includes('BMMiner') || vText.toLowerCase().includes('antminer')) { return false; }
  }
  if (!stats) { return true; }
  return !/"MM ID0(:Summary)?" *: *"[^"]/.test(stats.toString('utf8'));
}

// Non-empty "MM ID0:Summary" — the specific field the app's estats/litestats
// failover parser requires.
function hasUsableMMIDSummary(data) {
  return /"MM ID0:Summary" *: *"[^"]/.test(data.toString('utf8'));
}

// Layer C — FIXED action map. The action string is NEVER interpolated into the
// URL path (the old `/api/system/${action}` form was an SSRF path-injection
// primitive). Unknown actions are rejected. `restart` → POST /api/system/restart;
// `settings` → PATCH /api/system with a JSON body.
//
// For `settings`, new apps send correctly-typed JSON in `bodyBuffer` (forwarded
// VERBATIM — BitAxe rejects stringified numbers like {"frequency":"605"}). Old
// apps send `params`; those get serialized with Int-parseable values coerced to
// JSON numbers as a best-effort legacy path.
function forwardBitAxeAction(target, action, params, bodyBuffer) {
  let method;
  let path;
  let postData;

  if (action === 'restart') {
    method = 'POST';
    path = '/api/system/restart';
    postData = null;
  } else if (action === 'settings') {
    method = 'PATCH';
    path = '/api/system';
    if (bodyBuffer && bodyBuffer.length > 0) {
      postData = bodyBuffer; // verbatim, already correctly-typed JSON
    } else if (params && Object.keys(params).length > 0) {
      const object = {};
      for (const [key, value] of Object.entries(params)) {
        const n = Number(value);
        object[key] = (typeof value === 'string' && value.trim() !== '' && Number.isInteger(n)) ? n : value;
      }
      postData = Buffer.from(JSON.stringify(object));
    } else {
      postData = Buffer.from('{}');
    }
  } else {
    return Promise.reject(new Error(`Unknown action: ${action}`));
  }

  return new Promise((resolve, reject) => {
    const [host, port] = splitHostPort(target, 80);
    const headers = {};
    if (postData) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = Buffer.byteLength(postData);
    }
    const req = http.request({
      hostname: host, port, path, method, headers, timeout: CGMINER_TIMEOUT_MS,
    }, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) resolve(body);
        else reject(new Error(`BitAxe HTTP ${res.statusCode}`));
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    if (postData) req.write(postData);
    req.end();
  });
}

class MinerProxy {
  constructor(scanner) {
    this.scanner = scanner;
    this.startTime = Date.now();
    // Replay protection: request id -> firstSeenAt (ms). Insertion order == time
    // order, so TTL pruning and oldest-eviction both pop from the front.
    this._seenIDs = new Map();
  }

  async handleRequest(request) {
    try {
      // Freshness (spec §2): mutating actions must carry a recent issuedAt.
      // Reads (listMiners/minerStatus/bridgeInfo) are idempotent, so legacy
      // apps without issuedAt keep monitoring.
      if (request.type === RequestType.MINER_ACTION) {
        if (request.issuedAt === undefined || request.issuedAt === null) {
          return createResponse(request.id, false, 'This bridge requires a newer version of HashPulse.');
        }
        if (Math.abs(Date.now() / 1000 - Number(request.issuedAt)) > ACTION_FRESHNESS_SEC) {
          return createResponse(request.id, false, 'Request expired.');
        }
      }

      // Replay: ChaChaPoly gives integrity, not freshness — the relay can
      // duplicate frames verbatim. A request id may only ever execute once.
      if (!this._registerRequestID(request.id)) {
        console.warn(`[MinerProxy] Rejected duplicate request id ${request.id}`);
        return createResponse(request.id, false, 'Duplicate request.');
      }

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

  // Insert a request id into the seen-cache. Returns false if it was already
  // present (duplicate). Prunes expired entries and caps the map size.
  _registerRequestID(id) {
    const now = Date.now();
    for (const [key, firstSeen] of this._seenIDs) {
      if (now - firstSeen > SEEN_ID_TTL_MS) this._seenIDs.delete(key);
      else break; // Map preserves insertion order; first live entry ends the sweep.
    }
    if (this._seenIDs.has(id)) return false;
    this._seenIDs.set(id, now);
    if (this._seenIDs.size > SEEN_ID_MAX) {
      const oldest = this._seenIDs.keys().next().value;
      this._seenIDs.delete(oldest);
    }
    return true;
  }

  // Layer B — the target must be a miner this bridge's scanner actually
  // discovered. One rescan retry covers a stale cache before rejecting.
  //
  // Matching is on IP ONLY — deliberately NOT on port. The scanner probes
  // cgminer on 4028 only, so an Avalon Nano 3S running on :4029 (a supported
  // multi-miner setup) could never appear in the cache with that port; an
  // IP+port match would make those devices permanently unreachable. The port is
  // constrained independently by Layer A's structural allowlist ({80,443,4028,
  // 4029}). Do NOT "tighten" this to include the port.
  async _ensureDiscoveredMiner(host) {
    const known = (miners) => miners.some((m) => m.ip === host);
    if (known(this.scanner.miners)) return;
    await this.scanner.scan();
    if (known(this.scanner.miners)) return;
    throw new Error('Target is not a miner discovered by this bridge.');
  }

  async _handleMinerStatus(request) {
    if (!request.target) return createResponse(request.id, false, 'No target IP');
    const { host } = validateTarget(request.target);
    await this._ensureDiscoveredMiner(host);
    const ip = request.target;
    const protocol = request.minerProtocol || 'bitaxeHTTP';
    if (protocol === 'bitaxeHTTP') {
      const raw = await fetchBitAxeStatus(ip);
      return createMinerStatusResponse(request.id, Buffer.from(raw));
    }
    const envelope = await fetchCGMinerStatus(ip);
    return createMinerStatusResponse(request.id, Buffer.from(JSON.stringify(envelope)));
  }

  async _handleMinerAction(request) {
    if (!request.target) return createResponse(request.id, false, 'No target IP');
    const action = request.action;
    if (!action) return createResponse(request.id, false, 'No action specified');
    const { host } = validateTarget(request.target);
    await this._ensureDiscoveredMiner(host);
    const ip = request.target;
    const params = request.parameters || {};
    const body = request.body ? Buffer.from(request.body, 'base64') : null;
    const protocol = request.minerProtocol || 'bitaxeHTTP';
    if (protocol === 'bitaxeHTTP') {
      await forwardBitAxeAction(ip, action, params, body);
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
      minAppVersion: MIN_APP_VERSION,
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
  forwardBitAxeAction,
  sendAntminerPoolConfig,
  parseDigestChallenge,
  buildDigestAuthHeader,
  validateTarget,
  validateFreeform,
  requireInt,
};
