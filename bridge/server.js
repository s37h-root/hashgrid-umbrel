'use strict';

const express = require('express');
const path = require('node:path');
const crypto = require('node:crypto');
const { loadOrCreateAuthToken } = require('./persistence');

// Loopback peers only. Under Umbrel the app runs with `network_mode: host` and
// is reached through Umbrel's authenticated app-proxy, which connects over
// localhost — so a loopback TCP peer is the proxy (already user-authenticated),
// while a non-loopback peer is a LAN-adjacent host hitting the port directly.
// We read the raw socket address (NOT X-Forwarded-For, which a client can
// spoof) so this cannot be forged from off-host.
function isLoopback(req) {
  const addr = req.socket && req.socket.remoteAddress;
  if (!addr) return false;
  return addr === '::1' || addr === '::ffff:127.0.0.1' || addr.startsWith('127.');
}

function extractToken(req) {
  const header = req.get('X-Auth-Token');
  if (header) return header;
  const auth = req.get('Authorization') || '';
  if (auth.startsWith('Bearer ')) return auth.slice(7);
  return null;
}

function createServer(bridgeManager) {
  const app = express();

  // The auth token is the load-bearing control-API defense: without it, any
  // LAN-adjacent host could POST /api/pairing/enter + GET /api/code, join the
  // relay room and repoint miners (reward theft). Generated + persisted once on
  // first boot; the legitimate UI fetches it from the loopback-only /api/session.
  const AUTH_TOKEN = loadOrCreateAuthToken();
  const AUTH_TOKEN_BUF = Buffer.from(AUTH_TOKEN);

  function tokenMatches(provided) {
    if (typeof provided !== 'string') return false;
    const buf = Buffer.from(provided);
    // timingSafeEqual throws on length mismatch; length is not secret (fixed
    // 64-hex), so short-circuit, then constant-time compare the bytes.
    if (buf.length !== AUTH_TOKEN_BUF.length) return false;
    return crypto.timingSafeEqual(buf, AUTH_TOKEN_BUF);
  }

  // Auth gate for mutating/secret routes. Requiring a custom header that the
  // attacker cannot read (it's handed out only over loopback) is also the CSRF
  // defense: a cross-origin <form> POST cannot set X-Auth-Token without a CORS
  // preflight, and the browser will never attach the token for another origin.
  function requireAuth(req, res, next) {
    if (!tokenMatches(extractToken(req))) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    next();
  }

  // Loopback-only gate for endpoints that must reach the trusted proxy but
  // never a LAN host (the token bootstrap and the code-bearing widget feed).
  function requireLoopback(req, res, next) {
    if (!isLoopback(req)) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    next();
  }

  app.use(express.json());
  app.use(express.static(path.join(__dirname, '..', 'public')));

  // Token bootstrap for the local web UI. Loopback-only so a LAN attacker who
  // hits the host port directly cannot read the token.
  app.get('/api/session', requireLoopback, (req, res) => {
    res.json({ token: AUTH_TOKEN });
  });

  app.get('/api/status', requireAuth, (req, res) => {
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

  app.get('/api/miners', requireAuth, (req, res) => {
    res.json(bridgeManager.scanner.miners);
  });

  app.get('/api/code', requireAuth, (req, res) => {
    res.json({ code: bridgeManager.code });
  });

  app.post('/api/code/regenerate', requireAuth, (req, res) => {
    bridgeManager.regenerateCode();
    res.json({ code: bridgeManager.code });
  });

  // Headless pairing-mode control. Opening this window lets a NEW phone's key
  // pin without rotating the code (auto-closes after 10 min or on first pin).
  app.post('/api/pairing/enter', requireAuth, (req, res) => {
    bridgeManager.enterPairingMode();
    res.json({ pairingModeActive: bridgeManager.pairingModeActive });
  });

  // Umbrel dashboard widget endpoint. Loopback-only: it exposes the pairing
  // code in plaintext, so it must not be readable by a LAN host. Umbrel's
  // widget system polls it server-side over localhost.
  app.get('/api/widget', requireLoopback, (req, res) => {
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

  app.get('/api/settings', requireAuth, (req, res) => {
    const { loadSettings } = require('./persistence');
    res.json(loadSettings());
  });

  app.post('/api/settings', requireAuth, (req, res) => {
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
