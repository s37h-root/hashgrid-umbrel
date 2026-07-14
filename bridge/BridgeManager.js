'use strict';

const { MinerScanner } = require('./MinerScanner');
const { MinerProxy } = require('./MinerProxy');
const { RelayClient, generatePairingCode } = require('./RelayClient');
const crypto = require('./BridgeCrypto');
const {
  loadPairingCode,
  savePairingCode,
  loadPairedAppKey,
  savePairedAppKey,
  clearPairedAppKey,
  loadSettings,
} = require('./persistence');

// How long a New-Code / Pair-New-Device window stays open before auto-closing.
const PAIRING_MODE_DURATION_MS = 10 * 60 * 1000; // 10 minutes

class BridgeManager {
  constructor() {
    this.scanner = new MinerScanner();
    this.proxy = new MinerProxy(this.scanner);
    this.identity = crypto.loadOrCreateIdentity();
    this.relay = null;
    this.code = null;
    this.state = 'disconnected';
    this.peerConnected = false;
    this.connectedDevice = null;
    this.startTime = Date.now();

    // App-key binding. pairedAppKey (raw X25519 pubkey Buffer) = the phone this
    // bridge is bound to; null = never paired. pairingModeActive gates whether
    // a NEW key may pair; it auto-expires after 10 minutes.
    this.pairedAppKey = loadPairedAppKey();
    this.pairingModeActive = false;
    this.lastUnknownDeviceAttempt = null;
    this._pairingModeTimer = null;
  }

  get identityFingerprint() { return this.identity.fingerprint; }

  start() {
    this.code = loadPairingCode();
    if (!this.code) {
      this.code = generatePairingCode();
      savePairingCode(this.code);
    }
    // Fresh install (or freshly unpaired) — allow the first pairing.
    if (!this.pairedAppKey) this.enterPairingMode();

    const settings = loadSettings();
    if (settings.customSubnet) {
      this.scanner.setCustomSubnet(settings.customSubnet);
    }
    this.scanner.start();
    console.log(`[Bridge] Scanning subnet: ${this.scanner.getSubnet() || 'none detected'}`);
    this._connectRelay();
    console.log(`[Bridge] Started with code: ${this.code}`);
    console.log(`[Bridge] Identity fingerprint: ${this.identityFingerprint}`);
  }

  // "New Code" / "Pair New Device": rotate the code AND open the pairing window
  // so the user can bind a different phone.
  regenerateCode() {
    this.code = generatePairingCode();
    savePairingCode(this.code);
    console.log(`[Bridge] New code: ${this.code}`);
    this.enterPairingMode();
    if (this.relay) { this.relay.disconnect(); }
    this._connectRelay();
  }

  stop() {
    this.scanner.stop();
    if (this._pairingModeTimer) { clearTimeout(this._pairingModeTimer); this._pairingModeTimer = null; }
    if (this.relay) { this.relay.disconnect(); this.relay = null; }
  }

  // MARK: - Pairing mode (app-key binding window)

  // Headless mechanism: there is no desktop UI, so the pairing window is opened
  // from the web UI (POST /api/pairing/enter, also triggered by regenerateCode)
  // and closes automatically after 10 minutes or as soon as a key is pinned.
  enterPairingMode() {
    this.pairingModeActive = true;
    this.lastUnknownDeviceAttempt = null;
    if (this._pairingModeTimer) clearTimeout(this._pairingModeTimer);
    this._pairingModeTimer = setTimeout(() => {
      this.pairingModeActive = false;
      console.log('[Bridge] Pairing mode expired after 10 minutes');
    }, PAIRING_MODE_DURATION_MS);
    if (this._pairingModeTimer.unref) this._pairingModeTimer.unref();
    console.log('[Bridge] Pairing mode active for 10 minutes');
  }

  // Called by RelayClient BEFORE it derives a shared key. Returning false
  // leaves the live session completely untouched (no re-key, no reply).
  evaluateKeyExchange(appKey) {
    if (this.pairedAppKey) {
      if (Buffer.compare(appKey, this.pairedAppKey) === 0) {
        return true; // Normal reconnect from the paired app.
      }
      if (this.pairingModeActive) {
        this._pinAppKey(appKey); // User is deliberately pairing a new phone.
        console.log('[Bridge] Re-pinned new app key while in pairing mode');
        return true;
      }
      console.warn('[Bridge] REJECTED key exchange: unknown app key while paired and not in pairing mode');
      this.lastUnknownDeviceAttempt = Date.now();
      return false;
    }
    if (this.pairingModeActive) {
      this._pinAppKey(appKey);
      console.log('[Bridge] Pinned first app key');
      return true;
    }
    console.warn('[Bridge] REJECTED key exchange: never paired and pairing mode inactive');
    return false;
  }

  _pinAppKey(appKey) {
    this.pairedAppKey = Buffer.from(appKey);
    savePairedAppKey(this.pairedAppKey);
    this.pairingModeActive = false;
    if (this._pairingModeTimer) { clearTimeout(this._pairingModeTimer); this._pairingModeTimer = null; }
    this.lastUnknownDeviceAttempt = null;
  }

  // MARK: - Unpair

  // Steps 1–2, run BEFORE the success response goes out: clear the pinned key
  // and rotate the pairing code so the old room is abandoned.
  _prepareUnpair() {
    this.pairedAppKey = null;
    clearPairedAppKey();
    this.code = generatePairingCode();
    savePairingCode(this.code);
    console.log('[Bridge] Unpair: cleared paired app key and rotated pairing code');
  }

  // Steps 4–5, run AFTER the response was sent: reconnect to the new room and
  // re-enter pairing mode (the user will want to pair something next).
  _completeUnpair() {
    if (this.relay) { this.relay.disconnect(); }
    this.enterPairingMode();
    this._connectRelay();
  }

  _connectRelay() {
    this.relay = new RelayClient(this.code, {
      identity: this.identity,
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
      shouldAcceptKey: (appKey) => this.evaluateKeyExchange(appKey),
      onRequest: async (request) => {
        const response = await this.proxy.handleRequest(request);
        // Clear the pin + rotate the code BEFORE the response is sent; the
        // relay teardown itself waits for onUnpaired.
        if (request.type === 'unpair' && response && response.success) {
          this._prepareUnpair();
        }
        return response;
      },
      onUnpaired: () => this._completeUnpair(),
    });
    this.relay.connect();
  }
}

module.exports = { BridgeManager };
