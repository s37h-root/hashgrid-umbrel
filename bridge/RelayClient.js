'use strict';

const WebSocket = require('ws');
const crypto = require('./BridgeCrypto');
const { EnvelopeType, createEnvelope, parseEnvelope } = require('./BridgeProtocol');

const RELAY_URL = 'wss://hashgrid-relay.root373.workers.dev';
const PING_INTERVAL_MS = 30_000;
const MAX_RECONNECT_ATTEMPTS = 10;

const PAIRING_CHARSET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

const ConnectionState = {
  DISCONNECTED: 'disconnected',
  CONNECTING: 'connecting',
  WAITING_FOR_PEER: 'waitingForPeer',
  CONNECTED: 'connected',
  ERROR: 'error',
};

function generatePairingCode() {
  let code = '';
  const bytes = require('node:crypto').randomBytes(8);
  for (let i = 0; i < 8; i++) {
    code += PAIRING_CHARSET[bytes[i] % PAIRING_CHARSET.length];
  }
  return code;
}

class RelayClient {
  constructor(code, callbacks) {
    this.code = code;
    this.callbacks = callbacks;
    this.state = ConnectionState.DISCONNECTED;
    this.ws = null;
    this.keyPair = crypto.generateKeyPair();
    this.sharedKey = null;
    this.peerPublicKey = null;
    this._pingTimer = null;
    this._reconnectAttempt = 0;
    this._closed = false;
  }

  get fingerprint() {
    return crypto.fingerprint(this.keyPair.publicKey);
  }

  connect() {
    if (this._closed) return;
    this._setState(ConnectionState.CONNECTING);
    const url = `${RELAY_URL}/room/${this.code}?role=bridge`;
    this.ws = new WebSocket(url);

    this.ws.on('open', () => {
      this._reconnectAttempt = 0;
      this._setState(ConnectionState.WAITING_FOR_PEER);
      this._startPing();
    });

    this.ws.on('message', (data) => { this._handleMessage(data.toString()); });
    this.ws.on('close', () => { this._stopPing(); if (!this._closed) this._reconnect(); });
    this.ws.on('error', (err) => { console.error('[RelayClient] WebSocket error:', err.message); });
  }

  disconnect() {
    this._closed = true;
    this._stopPing();
    if (this.ws) { this.ws.close(); this.ws = null; }
    this._setState(ConnectionState.DISCONNECTED);
  }

  sendResponse(response) {
    if (!this.sharedKey || !this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    const plaintext = Buffer.from(JSON.stringify(response));
    const encrypted = crypto.encrypt(plaintext, this.sharedKey);
    const envelope = createEnvelope(EnvelopeType.ENCRYPTED, encrypted);
    this.ws.send(JSON.stringify(envelope));
  }

  _handleMessage(rawMessage) {
    let envelope;
    try { envelope = parseEnvelope(rawMessage); } catch { return; }

    switch (envelope.type) {
      case EnvelopeType.PUBLIC_KEY:
        this._handleKeyExchange(envelope.payload);
        break;
      case EnvelopeType.ENCRYPTED:
        this._handleEncrypted(envelope.payload);
        break;
      case EnvelopeType.PING:
        this._sendPong();
        break;
      case EnvelopeType.APP_STATUS: {
        const status = envelope.payload ? Buffer.from(envelope.payload, 'base64').toString() : null;
        const isOnline = status === 'online';
        if (this.callbacks.onPeerStatus) this.callbacks.onPeerStatus(isOnline);
        if (!isOnline && this.state === ConnectionState.CONNECTED) {
          this.sharedKey = null;
          this.peerPublicKey = null;
          this.keyPair = crypto.generateKeyPair();
          this._setState(ConnectionState.WAITING_FOR_PEER);
        }
        break;
      }
      default: break;
    }
  }

  _handleKeyExchange(payloadBase64) {
    try {
      const pairingJSON = Buffer.from(payloadBase64, 'base64').toString();
      const pairing = JSON.parse(pairingJSON);
      if (!pairing.publicKey) return;

      this.peerPublicKey = Buffer.from(pairing.publicKey, 'base64');
      this.sharedKey = crypto.deriveSharedKey(this.keyPair.secretKey, this.peerPublicKey);

      const ourPairing = {
        type: 'keyExchange',
        publicKey: Buffer.from(this.keyPair.publicKey).toString('base64'),
        fingerprint: this.fingerprint,
        deviceName: require('node:os').hostname(),
      };
      const envelope = createEnvelope(EnvelopeType.PUBLIC_KEY, Buffer.from(JSON.stringify(ourPairing)));
      this.ws.send(JSON.stringify(envelope));

      this._setState(ConnectionState.CONNECTED);
      if (this.callbacks.onDeviceConnected && pairing.deviceName) {
        this.callbacks.onDeviceConnected(pairing.deviceName);
      }
    } catch (err) { console.error('[RelayClient] Key exchange error:', err.message); }
  }

  _handleEncrypted(payloadBase64) {
    if (!this.sharedKey) return;
    try {
      const encrypted = Buffer.from(payloadBase64, 'base64');
      const decrypted = crypto.decrypt(encrypted, this.sharedKey);
      const request = JSON.parse(decrypted.toString());
      if (this.callbacks.onRequest) this.callbacks.onRequest(request);
    } catch (err) { console.error('[RelayClient] Decrypt/parse error:', err.message); }
  }

  _sendPong() {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(createEnvelope(EnvelopeType.PONG, null)));
    }
  }

  _startPing() {
    this._stopPing();
    this._pingTimer = setInterval(() => {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify(createEnvelope(EnvelopeType.PING, null)));
      }
    }, PING_INTERVAL_MS);
  }

  _stopPing() {
    if (this._pingTimer) { clearInterval(this._pingTimer); this._pingTimer = null; }
  }

  _reconnect() {
    this._stopPing();
    this._setState(ConnectionState.DISCONNECTED);
    if (this._reconnectAttempt >= MAX_RECONNECT_ATTEMPTS) {
      this._setState(ConnectionState.ERROR);
      console.error('[RelayClient] Max reconnect attempts reached');
      return;
    }
    const delay = Math.min(this._reconnectAttempt * this._reconnectAttempt, 30) * 1000;
    this._reconnectAttempt++;
    console.log(`[RelayClient] Reconnecting in ${delay / 1000}s (attempt ${this._reconnectAttempt})`);
    setTimeout(() => this.connect(), delay);
  }

  _setState(newState) {
    if (this.state === newState) return;
    this.state = newState;
    if (this.callbacks.onStateChange) this.callbacks.onStateChange(newState);
  }
}

module.exports = { RelayClient, ConnectionState, PAIRING_CHARSET, generatePairingCode };
