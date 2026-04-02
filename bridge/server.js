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
      fingerprint: bridgeManager.relay ? bridgeManager.relay.fingerprint : null,
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
