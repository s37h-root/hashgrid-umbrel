'use strict';

const { MinerScanner } = require('./MinerScanner');
const { MinerProxy } = require('./MinerProxy');
const { RelayClient, generatePairingCode } = require('./RelayClient');
const { loadPairingCode, savePairingCode, loadSettings } = require('./persistence');

class BridgeManager {
  constructor() {
    this.scanner = new MinerScanner();
    this.proxy = new MinerProxy(this.scanner);
    this.relay = null;
    this.code = null;
    this.state = 'disconnected';
    this.peerConnected = false;
    this.connectedDevice = null;
    this.startTime = Date.now();
  }

  start() {
    this.code = loadPairingCode();
    if (!this.code) {
      this.code = generatePairingCode();
      savePairingCode(this.code);
    }
    const settings = loadSettings();
    if (settings.customSubnet) {
      this.scanner.setCustomSubnet(settings.customSubnet);
    }
    this.scanner.start();
    console.log(`[Bridge] Scanning subnet: ${this.scanner.getSubnet() || 'none detected'}`);
    this._connectRelay();
    console.log(`[Bridge] Started with code: ${this.code}`);
  }

  regenerateCode() {
    this.code = generatePairingCode();
    savePairingCode(this.code);
    console.log(`[Bridge] New code: ${this.code}`);
    if (this.relay) { this.relay.disconnect(); }
    this._connectRelay();
  }

  stop() {
    this.scanner.stop();
    if (this.relay) { this.relay.disconnect(); this.relay = null; }
  }

  _connectRelay() {
    this.relay = new RelayClient(this.code, {
      onStateChange: (state) => {
        this.state = state;
        console.log(`[Bridge] State: ${state}`);
      },
      onPeerStatus: (online) => {
        this.peerConnected = online;
        if (!online) this.connectedDevice = null;
        console.log(`[Bridge] Peer ${online ? 'online' : 'offline'}`);
      },
      onDeviceConnected: (name) => {
        this.connectedDevice = name;
        console.log(`[Bridge] Device connected: ${name}`);
      },
      onRequest: async (request) => {
        const response = await this.proxy.handleRequest(request);
        this.relay.sendResponse(response);
      },
    });
    this.relay.connect();
  }
}

module.exports = { BridgeManager };
