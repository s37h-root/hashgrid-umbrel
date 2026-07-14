'use strict';

const fs = require('node:fs');
const path = require('node:path');

const DATA_DIR = process.env.DATA_DIR || './data';

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
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
  try { fs.chmodSync(file, 0o600); } catch { /* best-effort owner-only perms */ }
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

module.exports = {
  loadPairingCode,
  savePairingCode,
  loadPairedAppKey,
  savePairedAppKey,
  clearPairedAppKey,
  loadIdentityDER,
  saveIdentityDER,
  loadSettings,
  saveSettings,
};
