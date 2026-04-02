'use strict';

const http = require('node:http');

const BRIDGE_URL = process.env.BRIDGE_URL || 'http://localhost:3000';

async function fetchBridgeStatus() {
  return new Promise((resolve, reject) => {
    http.get(`${BRIDGE_URL}/api/status`, { timeout: 5000 }, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        try { resolve(JSON.parse(body)); } catch { reject(new Error('parse error')); }
      });
    }).on('error', reject).on('timeout', function () { this.destroy(); reject(new Error('timeout')); });
  });
}

async function fetchBridgeCode() {
  return new Promise((resolve, reject) => {
    http.get(`${BRIDGE_URL}/api/code`, { timeout: 5000 }, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        try { resolve(JSON.parse(body)); } catch { reject(new Error('parse error')); }
      });
    }).on('error', reject).on('timeout', function () { this.destroy(); reject(new Error('timeout')); });
  });
}

const STATE_LABELS = {
  disconnected: 'Offline',
  connecting: 'Connecting',
  waitingForPeer: 'Waiting',
  connected: 'Connected',
  error: 'Error',
};

const server = http.createServer(async (req, res) => {
  if (req.url === '/widgets/status') {
    try {
      const [status, code] = await Promise.all([fetchBridgeStatus(), fetchBridgeCode()]);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        type: 'four-stats',
        refresh: '30s',
        link: '',
        items: [
          { title: 'Pairing Code', text: code.code || '--------', subtext: '' },
          { title: 'Relay', text: STATE_LABELS[status.state] || status.state, subtext: '' },
          { title: 'Miners', text: String(status.minerCount || 0), subtext: 'found' },
          { title: 'Peer', text: status.peerConnected ? 'Online' : 'Offline', subtext: '' },
        ],
      }));
    } catch {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        type: 'four-stats',
        refresh: '30s',
        link: '',
        items: [
          { title: 'Pairing Code', text: '--', subtext: '' },
          { title: 'Relay', text: '--', subtext: '' },
          { title: 'Miners', text: '--', subtext: '' },
          { title: 'Peer', text: '--', subtext: '' },
        ],
      }));
    }
  } else {
    res.writeHead(404);
    res.end('Not found');
  }
});

const PORT = parseInt(process.env.PORT, 10) || 3001;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`[Widget] Listening on port ${PORT}`);
});
