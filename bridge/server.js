'use strict';

const express = require('express');
const path = require('node:path');

function createServer(bridgeManager) {
  const app = express();
  app.use(express.json());
  app.use(express.static(path.join(__dirname, '..', 'public')));

  app.get('/api/status', (req, res) => {
    res.json({
      state: bridgeManager.state,
      peerConnected: bridgeManager.peerConnected,
      connectedDevice: bridgeManager.connectedDevice,
      minerCount: bridgeManager.scanner.miners.length,
      subnet: bridgeManager.scanner.getSubnet(),
      uptime: (Date.now() - bridgeManager.startTime) / 1000,
      // Ephemeral (per-session) fingerprint — kept for backwards-compat/debug.
      fingerprint: bridgeManager.relay ? bridgeManager.relay.fingerprint : null,
      // Persistent 48-bit identity fingerprint the iOS app pins (TOFU). Stable
      // across restarts — this is the one users verify.
      identityFingerprint: bridgeManager.identityFingerprint,
      paired: bridgeManager.pairedAppKey != null,
      pairingModeActive: bridgeManager.pairingModeActive,
      lastUnknownDeviceAttempt: bridgeManager.lastUnknownDeviceAttempt,
    });
  });

  app.get('/api/miners', (req, res) => {
    res.json(bridgeManager.scanner.miners);
  });

  app.get('/api/code', (req, res) => {
    res.json({ code: bridgeManager.code });
  });

  app.post('/api/code/regenerate', (req, res) => {
    bridgeManager.regenerateCode();
    res.json({ code: bridgeManager.code });
  });

  // Headless pairing-mode control. Opening this window lets a NEW phone's key
  // pin without rotating the code (auto-closes after 10 min or on first pin).
  app.post('/api/pairing/enter', (req, res) => {
    bridgeManager.enterPairingMode();
    res.json({ pairingModeActive: bridgeManager.pairingModeActive });
  });

  // Umbrel dashboard widget endpoint
  app.get('/api/widget', (req, res) => {
    const stateLabels = {
      disconnected: 'Offline',
      connecting: 'Connecting',
      waitingForPeer: 'Waiting',
      connected: 'Connected',
      error: 'Error',
    };
    res.json({
      type: 'four-stats',
      items: [
        { title: 'Pairing Code', text: bridgeManager.code || '--------', subtext: '' },
        { title: 'Relay', text: stateLabels[bridgeManager.state] || bridgeManager.state, subtext: '' },
        { title: 'Miners', text: String(bridgeManager.scanner.miners.length), subtext: 'found' },
        { title: 'Peer', text: bridgeManager.peerConnected ? 'Online' : 'Offline', subtext: '' },
      ],
    });
  });

  app.get('/api/settings', (req, res) => {
    const { loadSettings } = require('./persistence');
    res.json(loadSettings());
  });

  app.post('/api/settings', (req, res) => {
    const { saveSettings, loadSettings } = require('./persistence');
    const settings = loadSettings();
    if (req.body.customSubnet !== undefined) {
      settings.customSubnet = req.body.customSubnet || null;
      bridgeManager.scanner.setCustomSubnet(settings.customSubnet);
    }
    saveSettings(settings);
    res.json(settings);
  });

  return app;
}

module.exports = { createServer };
