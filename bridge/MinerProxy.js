'use strict';

const http = require('node:http');
const net = require('node:net');
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
const BRIDGE_VERSION = '1.0.0';
const BRIDGE_PLATFORM = 'umbrel';

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
    default:
      return { command: action };
  }
}

function sendCGMinerCommand(ip, command) {
  return new Promise((resolve, reject) => {
    const socket = new net.Socket();
    let data = '';
    socket.setTimeout(CGMINER_TIMEOUT_MS);
    socket.connect(CGMINER_PORT, ip, () => { socket.write(JSON.stringify(command) + '\n'); });
    socket.on('data', (chunk) => { data += chunk.toString(); });
    socket.on('end', () => { socket.destroy(); resolve(data.replace(/\0+$/, '')); });
    socket.on('error', (err) => { socket.destroy(); reject(err); });
    socket.on('timeout', () => { socket.destroy(); reject(new Error('timeout')); });
  });
}

function fetchBitAxeStatus(ip) {
  return new Promise((resolve, reject) => {
    const req = http.get(`http://${ip}/api/system/info`, { timeout: BITAXE_STATUS_TIMEOUT_MS }, (res) => {
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

function sendBitAxeAction(ip, action, params) {
  return new Promise((resolve, reject) => {
    const postData = JSON.stringify(params || {});
    const req = http.request({
      hostname: ip, port: 80, path: `/api/system/${action}`, method: 'POST',
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
    const cmd = buildCGMinerCommand(action, params);
    await sendCGMinerCommand(ip, cmd);
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

module.exports = { MinerProxy, buildCGMinerCommand, sendCGMinerCommand, fetchBitAxeStatus, fetchCGMinerStatus };
