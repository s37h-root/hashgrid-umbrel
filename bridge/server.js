'use strict';

const express = require('express');
const path = require('node:path');
const crypto = require('node:crypto');
const { loadOrCreateAuthToken } = require('./persistence');

// Normalize a raw socket peer address: strip the IPv4-mapped IPv6 prefix so
// `::ffff:172.18.0.5` compares as the plain IPv4 `172.18.0.5`.
function normalizeAddr(addr) {
  if (!addr) return '';
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(addr);
  return mapped ? mapped[1] : addr;
}

// Trusted bootstrap origin for the token/widget endpoints. We read the RAW
// socket address (NOT X-Forwarded-For, which a client can spoof) so this
// cannot be forged from off-host.
//
// The app runs `network_mode: host`, but Umbrel injects a BRIDGE-networked
// app_proxy that reaches this host-network app from a docker-subnet IP (e.g.
// `::ffff:172.x` / `10.21.x`), NOT loopback. So loopback-only would 403 the
// legitimate proxy and leave the UI with no token → every control route 401s →
// dead UI. We therefore accept loopback PLUS the RFC1918 ranges Docker uses for
// its bridge networks: 10.0.0.0/8 and 172.16.0.0/12. We deliberately EXCLUDE
// 192.168.0.0/16 (the common home-LAN range) so a typical LAN attacker still
// cannot fetch the token.
//
// HEURISTIC — MUST be confirmed on a live Umbrel: if the UI still 403s, add the
// proxy's actual observed source subnet here; if it works, consider tightening
// to that exact subnet. This only governs where the TOKEN can be bootstrapped;
// the control routes stay gated on the auth token regardless.
function isTrustedOrigin(req) {
  const addr = normalizeAddr(req.socket && req.socket.remoteAddress);
  if (!addr) return false;
  if (addr === '::1' || addr.startsWith('127.')) return true; // loopback (127/8, ::1)
  if (addr.startsWith('10.')) return true;                    // 10.0.0.0/8
  const m = /^172\.(\d+)\./.exec(addr);                       // 172.16.0.0/12
  if (m) {
    const second = Number(m[1]);
    if (second >= 16 && second <= 31) return true;
  }
  return false; // 192.168.0.0/16 and everything else rejected
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

  // The REAL auth boundary is now Umbrel's app-proxy. The bridge no longer runs
  // `network_mode: host`; it sits on the docker bridge network, so :3000 is not
  // exposed on the LAN at all — the only path to the control UI is through
  // Umbrel's authenticated app-proxy. That closes the LAN-auth hole cleanly and
  // makes this app-level token redundant, so it ships OPT-IN OFF (see below).
  // Kept (not removed) as defense-in-depth / a seam for non-Umbrel deployments.
  // Generated + persisted once on first boot; the UI fetches it from /api/session.
  const AUTH_TOKEN = loadOrCreateAuthToken();
  const AUTH_TOKEN_BUF = Buffer.from(AUTH_TOKEN);

  // Auth is OPT-IN (default OFF). Under `network_mode: host` the Umbrel app-proxy
  // and a LAN host can share the same subnet, so IP-based origin gating cannot
  // reliably distinguish them — enabling it 403'd the legitimate UI on real Umbrel
  // hardware (v1.0.8). Ship disabled until a proxy-safe mechanism is confirmed
  // (loopback bind + separate scanner, or a verified proxy subnet). The rejected
  // origin is logged below so the real proxy IP can be identified before enabling.
  // Set BRIDGE_AUTH_ENABLED=true to enforce.
  const AUTH_ENABLED = process.env.BRIDGE_AUTH_ENABLED === 'true';

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
    if (!AUTH_ENABLED) return next();
    if (!tokenMatches(extractToken(req))) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    next();
  }

  // Origin gate for endpoints that must reach the trusted Umbrel proxy but never
  // a LAN host (the token bootstrap and the code-bearing widget feed). Accepts
  // loopback + docker-bridge ranges; see isTrustedOrigin for the rationale.
  function requireLoopback(req, res, next) {
    if (!AUTH_ENABLED) return next();
    if (!isTrustedOrigin(req)) {
      // Log the actual source so the trusted proxy subnet can be identified from
      // `docker logs` before enabling auth on a live Umbrel.
      console.warn('[auth] rejected token-bootstrap from',
        normalizeAddr(req.socket && req.socket.remoteAddress));
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
      // Single source of truth for the version banner (package.json). Baked into
      // the image at build time; the UI reads this so it never drifts.
      version: require('../package.json').version,
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
