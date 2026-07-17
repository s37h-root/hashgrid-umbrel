'use strict';

const EnvelopeType = {
  PUBLIC_KEY: 'publicKey',
  ENCRYPTED: 'encrypted',
  PING: 'ping',
  PONG: 'pong',
  BRIDGE_STATUS: 'bridgeStatus',
  APP_STATUS: 'appStatus',
  LIVE_ACTIVITY_CONTROL: 'liveActivityControl',
  LIVE_ACTIVITY_PUSH: 'liveActivityPush',
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

function createLiveActivityPushEnvelope(pushObj) {
  const payload = Buffer.from(JSON.stringify(pushObj), 'utf8');
  return createEnvelope(EnvelopeType.LIVE_ACTIVITY_PUSH, payload);
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
        // Minimum app compatibility version this bridge speaks. iOS surfaces an
        // "update your app" banner when its compatibility number is lower. This
        // is how legacy apps (which can't send issuedAt) get told to update.
        minAppVersion: info.minAppVersion || null,
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
  createLiveActivityPushEnvelope,
  createResponse,
  createMinerListResponse,
  createMinerStatusResponse,
  createMinerActionResponse,
  createBridgeInfoResponse,
};
