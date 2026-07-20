'use strict';

const fs = require('node:fs');
const path = require('node:path');
const nodeCrypto = require('node:crypto');

const DATA_DIR = process.env.DATA_DIR || './data';

// The data dir holds the Ed25519 identity private key and the web-UI auth
// token, so it must not be readable by other local users. We tighten it to
// 0700 once per process (a guard avoids spamming the log if the underlying
// volume — e.g. an Umbrel bind mount — refuses chmod).
let _dirHardened = false;
function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
  }
  if (!_dirHardened) {
    _dirHardened = true;
    try {
      fs.chmodSync(DATA_DIR, 0o700);
    } catch (err) {
      console.error(
        `[persistence] SECURITY WARNING: could not restrict ${DATA_DIR} to 0700 (${err.message}); ` +
        'the identity private key may be readable by other local users.'
      );
    }
  }
}

// pairing.json holds BOTH the rotating pairing code and the pinned app key
// (the app's raw X25519 public key, base64). They live in one file because a
// naive savePairingCode() that wrote only { code } would silently wipe the
// pinned key — so all writes go through _loadPairing/_savePairing which
// read-modify-write the whole object.
function _loadPairing() {
  ensureDataDir();
  const file = path.join(DATA_DIR, 'pairing.json');
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) || {};
  } catch {
    return {};
  }
}

function _savePairing(obj) {
  ensureDataDir();
  const file = path.join(DATA_DIR, 'pairing.json');
  fs.writeFileSync(file, JSON.stringify({ ...obj, updatedAt: new Date().toISOString() }));
}

function loadPairingCode() {
  return _loadPairing().code || null;
}

function savePairingCode(code) {
  const p = _loadPairing();
  p.code = code;
  _savePairing(p);
}

// Pinned app public key (raw X25519, base64). null = never paired.
function loadPairedAppKey() {
  const b64 = _loadPairing().pairedAppKey;
  return b64 ? Buffer.from(b64, 'base64') : null;
}

function savePairedAppKey(keyBuffer) {
  const p = _loadPairing();
  p.pairedAppKey = Buffer.from(keyBuffer).toString('base64');
  _savePairing(p);
}

function clearPairedAppKey() {
  const p = _loadPairing();
  delete p.pairedAppKey;
  _savePairing(p);
}

// Persistent Ed25519 identity key, stored as base64 pkcs8-DER in identity.json.
// Generated once (see BridgeCrypto.loadOrCreateIdentity) and reused across
// restarts so the iOS app can pin the bridge identity (TOFU).
function loadIdentityDER() {
  ensureDataDir();
  const file = path.join(DATA_DIR, 'identity.json');
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    return data.privateKeyDER ? Buffer.from(data.privateKeyDER, 'base64') : null;
  } catch {
    return null;
  }
}

function saveIdentityDER(derBuffer) {
  ensureDataDir();
  const file = path.join(DATA_DIR, 'identity.json');
  fs.writeFileSync(
    file,
    JSON.stringify({ privateKeyDER: Buffer.from(derBuffer).toString('base64'), createdAt: new Date().toISOString() }),
    { mode: 0o600 }
  );
  // NON-silent 0600 enforcement: an Ed25519 private key readable by other local
  // users would let them impersonate this bridge's pinned identity. There is no
  // OS keystore on Umbrel, so 0600 owner-only perms are the strongest at-rest
  // protection available — verify they actually landed and shout if they didn't.
  try { fs.chmodSync(file, 0o600); } catch (err) {
    console.error(`[persistence] SECURITY WARNING: could not chmod identity key to 0600 (${err.message}).`);
  }
  try {
    const mode = fs.statSync(file).mode & 0o777;
    if (mode !== 0o600) {
      console.error(
        `[persistence] SECURITY WARNING: identity key ${file} has mode ${mode.toString(8)} (expected 600); ` +
        'the private key may be readable by other local users.'
      );
    }
  } catch (err) {
    console.error(`[persistence] SECURITY WARNING: could not verify identity key permissions (${err.message}).`);
  }
}

// Shared-secret token that authenticates the local web UI to the control API.
// Generated once on first boot and reused across restarts. Stored 0600 in the
// same locked-down data dir as the identity key. This is what stops a
// LAN-adjacent host from driving the unauthenticated control API (the bridge
// listens on the host network under Umbrel).
function loadOrCreateAuthToken() {
  ensureDataDir();
  const file = path.join(DATA_DIR, 'session.json');
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (data && typeof data.authToken === 'string' && data.authToken.length >= 32) {
      return data.authToken;
    }
  } catch { /* fall through and mint a fresh token */ }
  const token = nodeCrypto.randomBytes(32).toString('hex');
  fs.writeFileSync(
    file,
    JSON.stringify({ authToken: token, createdAt: new Date().toISOString() }),
    { mode: 0o600 }
  );
  try { fs.chmodSync(file, 0o600); } catch (err) {
    console.error(`[persistence] SECURITY WARNING: could not chmod ${file} to 0600 (${err.message}).`);
  }
  return token;
}

function loadSettings() {
  ensureDataDir();
  const file = path.join(DATA_DIR, 'settings.json');
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return { customSubnet: null };
  }
}

function saveSettings(settings) {
  ensureDataDir();
  const file = path.join(DATA_DIR, 'settings.json');
  fs.writeFileSync(file, JSON.stringify(settings, null, 2));
}

// activityState.json tracks the bridge's view of the iOS Live Activity
// lifecycle (Phase 2 push seam): whether the user has enabled it, whether one
// is currently active on the relay/device, and its activityId for targeting
// pushes. Read-modify-write like the pairing store above.
const ACTIVITY_FILE = path.join(DATA_DIR, 'activityState.json');

function loadActivityState() {
  try { return JSON.parse(fs.readFileSync(ACTIVITY_FILE, 'utf8')); }
  catch { return { active: false, enabled: false, activityId: null, updatedAt: 0 }; }
}
function saveActivityState(state) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(ACTIVITY_FILE, JSON.stringify({ ...state, updatedAt: Date.now() }));
}

module.exports = {
  loadPairingCode,
  savePairingCode,
  loadPairedAppKey,
  savePairedAppKey,
  clearPairedAppKey,
  loadIdentityDER,
  saveIdentityDER,
  loadOrCreateAuthToken,
  loadSettings,
  saveSettings,
  loadActivityState,
  saveActivityState,
};
