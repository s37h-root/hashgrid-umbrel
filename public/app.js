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
        fetch('/api/status'),
        fetch('/api/miners'),
        fetch('/api/code'),
      ]);

      const status = await statusRes.json();
      const miners = await minersRes.json();
      const code = await codeRes.json();

      codeEl.textContent = code.code;
      fingerprintEl.textContent = status.fingerprint || '';

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
        minersList.innerHTML = '<div class="empty-state">No miners found on ' + (status.subnet || 'network') + '</div>';
      } else {
        minersList.innerHTML = miners
          .map(function (m) {
            return (
              '<div class="miner-item">' +
              '<div><div class="miner-ip">' + m.ip + '</div>' +
              '<div class="miner-model">' + (m.deviceModel || 'Unknown') + '</div></div>' +
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
    await fetch('/api/code/regenerate', { method: 'POST' });
    refresh();
  });

  subnetSave.addEventListener('click', async function () {
    const value = subnetInput.value.trim();
    await fetch('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ customSubnet: value || null }),
    });
    subnetInput.value = value;
    refresh();
  });

  fetch('/api/settings')
    .then(function (res) { return res.json(); })
    .then(function (s) {
      if (s.customSubnet) subnetInput.value = s.customSubnet;
    });

  refresh();
  setInterval(refresh, 3000);
})();
