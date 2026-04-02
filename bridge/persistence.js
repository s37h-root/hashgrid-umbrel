'use strict';

const fs = require('node:fs');
const path = require('node:path');

const DATA_DIR = process.env.DATA_DIR || './data';

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

function loadPairingCode() {
  ensureDataDir();
  const file = path.join(DATA_DIR, 'pairing.json');
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    return data.code || null;
  } catch {
    return null;
  }
}

function savePairingCode(code) {
  ensureDataDir();
  const file = path.join(DATA_DIR, 'pairing.json');
  fs.writeFileSync(file, JSON.stringify({ code, createdAt: new Date().toISOString() }));
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

module.exports = { loadPairingCode, savePairingCode, loadSettings, saveSettings };
