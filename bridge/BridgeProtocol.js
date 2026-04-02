'use strict';

const EnvelopeType = {
  PUBLIC_KEY: 'publicKey',
  ENCRYPTED: 'encrypted',
  PING: 'ping',
  PONG: 'pong',
  BRIDGE_STATUS: 'bridgeStatus',
  APP_STATUS: 'appStatus',
};

const RequestType = {
  LIST_MINERS: 'listMiners',
  MINER_STATUS: 'minerStatus',
  MINER_ACTION: 'minerAction',
  BRIDGE_INFO: 'bridgeInfo',
  UNPAIR: 'unpair',
};

const MinerProtocolType = {
  BITAXE_HTTP: 'bitaxeHTTP',
  CGMINER_TCP: 'cgminerTCP',
  ANTMINER_CGI: 'antminerCGI',
};

function createEnvelope(type, payloadBuffer) {
  return {
    type,
    payload: payloadBuffer ? payloadBuffer.toString('base64') : null,
  };
}

function parseEnvelope(jsonString) {
  return JSON.parse(jsonString);
}

function createResponse(id, success, error) {
  const resp = { id, success };
  if (error) resp.error = error;
  return resp;
}

function createMinerListResponse(id, miners) {
  return {
    id,
    success: true,
    data: {
      type: 'minerList',
      value: { miners },
    },
  };
}

function createMinerStatusResponse(id, rawJSONBuffer) {
  return {
    id,
    success: true,
    data: {
      type: 'minerStatus',
      value: { rawJSON: rawJSONBuffer.toString('base64') },
    },
  };
}

function createMinerActionResponse(id, success, message) {
  return {
    id,
    success: true,
    data: {
      type: 'minerAction',
      value: { success, message: message || null },
    },
  };
}

function createBridgeInfoResponse(id, info) {
  return {
    id,
    success: true,
    data: {
      type: 'bridgeInfo',
      value: {
        version: info.version,
        platform: info.platform,
        uptime: info.uptime,
        minerCount: info.minerCount,
        hostname: info.hostname || null,
      },
    },
  };
}

module.exports = {
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
};
