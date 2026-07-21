(function () {
  'use strict';

  const codeEl = document.getElementById('pairing-code');
  const copyBtn = document.getElementById('copy-btn');
  const fingerprintEl = document.getElementById('fingerprint');
  const relayDot = document.getElementById('relay-dot');
  const relayStatus = document.getElementById('relay-status');
  const peerDot = document.getElementById('peer-dot');
  const peerStatus = document.getElementById('peer-status');
  const minerCount = document.getElementById('miner-count');
  const minersList = document.getElementById('miners-list');
  const subnetInput = document.getElementById('subnet-input');
  const subnetSave = document.getElementById('subnet-save');
  const regenerateBtn = document.getElementById('regenerate-btn');
  const pairBtn = document.getElementById('pair-btn');
  const pairingBanner = document.getElementById('pairing-banner');
  const unknownBanner = document.getElementById('unknown-banner');
  const versionEl = document.getElementById('version');

  function escapeHTML(str) {
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  // Shared-secret token that authenticates this UI to the control API. It is
  // handed out only over loopback (this page is served through Umbrel's proxy,
  // so /api/session sees a loopback peer), and attached as X-Auth-Token on every
  // control request below. Fetched once at startup before anything else runs.
  let AUTH_TOKEN = null;

  function authedFetch(url, opts) {
    const options = opts || {};
    const headers = Object.assign({}, options.headers);
    if (AUTH_TOKEN) headers['X-Auth-Token'] = AUTH_TOKEN;
    return fetch(url, Object.assign({}, options, { headers: headers }));
  }

  const STATE_LABELS = {
    disconnected: 'Disconnected',
    connecting: 'Connecting...',
    waitingForPeer: 'Waiting for HashGrid app',
    connected: 'Connected',
    error: 'Connection error',
  };

  const STATE_COLORS = {
    disconnected: 'red',
    connecting: 'orange',
    waitingForPeer: 'yellow',
    connected: 'green',
    error: 'red',
  };

  async function refresh() {
    try {
      const [statusRes, minersRes, codeRes] = await Promise.all([
        authedFetch('/api/status'),
        authedFetch('/api/miners'),
        authedFetch('/api/code'),
      ]);

      const status = await statusRes.json();
      const miners = await minersRes.json();
      const code = await codeRes.json();

      // Version banner is served from package.json via /api/status so it can't
      // drift from the running build.
      if (versionEl && status.version) versionEl.textContent = 'v' + status.version;

      codeEl.textContent = code.code;
      // Show the persistent identity fingerprint — the value the app pins/verifies.
      // Uppercased to match how the iOS app renders it (RemotePairingView shows
      // `fingerprint.uppercased()`), so the two read identically when the user
      // compares them side by side. Display-only: the raw lowercase hex is still
      // what's compared over the wire, so this must NOT touch the crypto layer.
      fingerprintEl.textContent = (status.identityFingerprint || status.fingerprint || '').toUpperCase();

      if (status.pairingModeActive) {
        pairingBanner.hidden = false;
        pairingBanner.textContent = 'Pairing mode active — a new device can pair for 10 minutes.';
      } else {
        pairingBanner.hidden = true;
      }

      if (status.lastUnknownDeviceAttempt) {
        unknownBanner.hidden = false;
        unknownBanner.textContent = 'An unknown device tried to connect and was blocked. If this was you, tap "Pair New Device".';
      } else {
        unknownBanner.hidden = true;
      }

      relayDot.className = 'status-dot ' + (STATE_COLORS[status.state] || 'red');
      relayStatus.textContent = STATE_LABELS[status.state] || status.state;

      if (status.peerConnected) {
        peerDot.className = 'status-dot green';
        peerStatus.textContent = status.connectedDevice || 'Device connected';
      } else {
        peerDot.className = 'status-dot red';
        peerStatus.textContent = 'No device connected';
      }

      minerCount.textContent = miners.length;
      if (miners.length === 0) {
        // Auto-detect is gone (bridge runs on the docker network, not host), so
        // the user must supply the subnet. Guide them when none is set / nothing found.
        minersList.innerHTML = status.subnet
          ? '<div class="empty-state">No miners found on ' + escapeHTML(status.subnet) + '</div>'
          : '<div class="empty-state">Enter your network\'s first 3 octets (e.g. 192.168.1) in Settings to scan for miners.</div>';
      } else {
        minersList.innerHTML = miners
          .map(function (m) {
            return (
              '<div class="miner-item">' +
              '<div><div class="miner-ip">' + escapeHTML(m.ip) + '</div>' +
              '<div class="miner-model">' + escapeHTML(m.deviceModel || 'Unknown') + '</div></div>' +
              '<span class="miner-protocol">' + (m.minerProtocol === 'bitaxeHTTP' ? 'BitAxe' : 'CGMiner') + '</span>' +
              '</div>'
            );
          })
          .join('');
      }
    } catch (err) {
      console.error('Refresh error:', err);
    }
  }

  copyBtn.addEventListener('click', function () {
    navigator.clipboard.writeText(codeEl.textContent).then(function () {
      copyBtn.classList.add('copied');
      setTimeout(function () { copyBtn.classList.remove('copied'); }, 1500);
    });
  });

  regenerateBtn.addEventListener('click', async function () {
    if (!confirm('Generate a new pairing code? You will need to re-pair in the HashGrid app.')) return;
    await authedFetch('/api/code/regenerate', { method: 'POST' });
    refresh();
  });

  pairBtn.addEventListener('click', async function () {
    await authedFetch('/api/pairing/enter', { method: 'POST' });
    refresh();
  });

  subnetSave.addEventListener('click', async function () {
    const value = subnetInput.value.trim();
    await authedFetch('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ customSubnet: value || null }),
    });
    subnetInput.value = value;
    refresh();
  });

  // Bootstrap: obtain the auth token first, then load settings and start the
  // refresh loop. Everything else depends on the token being present.
  async function init() {
    try {
      const res = await fetch('/api/session');
      if (res.ok) AUTH_TOKEN = (await res.json()).token;
    } catch (err) {
      console.error('Session bootstrap failed:', err);
    }

    try {
      const s = await (await authedFetch('/api/settings')).json();
      if (s.customSubnet) subnetInput.value = s.customSubnet;
    } catch (err) { /* non-fatal */ }

    refresh();
    setInterval(refresh, 3000);
  }

  init();
})();
