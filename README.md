# HashGrid Bridge for Umbrel

Remote miner monitoring bridge for the [HashGrid](https://hashgrid.app) iOS app. Connects your local Bitcoin miners to HashGrid for remote monitoring over an end-to-end encrypted connection.

## Supported Miners

- **BitAxe** (all models) — HTTP API on port 80
- **Canaan Avalon** (Nano 3S, Q, etc.) — CGMiner on port 4028
- **Antminer** — CGMiner on port 4028
- Any cgminer-compatible miner

## Installation

### From Umbrel Community App Store

1. Open your Umbrel dashboard
2. Go to **App Store** > **Community App Stores**
3. Add this store URL: `https://github.com/s37h-root/hashgrid-umbrel-store`
4. Install **HashGrid Bridge**

### Manual (Docker)

    docker run -d \
      --network host \
      --restart on-failure \
      -v hashgrid-data:/data \
      hashgrid-bridge:latest

## Usage

1. Click the HashGrid Bridge icon on your Umbrel dashboard
2. Note the 8-character pairing code
3. In the HashGrid iOS app, go to Settings > Remote Monitoring > Enter Code
4. Confirm the **Bridge Identity** fingerprint shown in the app matches the one on this page
5. Your miners will appear in the app immediately

Requires the HashGrid app **v2 or newer** for remote miner actions (reboot,
overclock, pool config). Older apps can still monitor and will be prompted to
update.

## Security

- **Bridge identity (TOFU)**: The bridge generates a persistent Ed25519 identity
  key on first launch and shows its 48-bit fingerprint. The app pins this at
  pairing and verifies it on every reconnect, so a compromised relay can't
  impersonate your bridge.
- **App-key pinning**: Once paired, only your phone's key is accepted. Another
  device holding the same code is rejected without disturbing your live session.
  To bind a new phone, click **Pair New Device** (opens a 10-minute window).
- **Replay & SSRF protection**: Duplicate/stale commands are rejected, and the
  bridge only talks to private-network miners it actually discovered.

### Network trust model (design decision)

The bridge runs with `network_mode: host` so it can auto-detect your LAN and scan
for miners with **zero configuration** — this is deliberate and is what makes the
app "just work." A consequence is that the local control panel (port 3000) is
reachable by any device **already on your home network**, the same trust boundary
as your router's admin page or the Umbrel dashboard itself.

An app-level auth token exists in the code (`BRIDGE_AUTH_ENABLED`, default **off**)
as defense-in-depth for non-Umbrel deployments. It ships disabled on Umbrel because
the only ways to gate the LAN port either (a) require the user to hand-enter their
subnet (moving off host networking), or (b) rely on an IP-origin heuristic that has
repeatedly broken the control UI on real hardware. The residual exposure is narrow:
hijacking a paired setup is blocked by **app-key pinning + the TOFU identity
fingerprint**, so an attacker would need a malicious device on your Wi-Fi *and* an
unpaired/pairing window. We accept this LAN-trust model rather than risk a broken
admin panel. **Do not "fix" this by removing host networking without also solving
zero-config subnet detection** — see the project memory for the v1.0.8/v1.0.10 post-mortems.

## Configuration

- **Custom Subnet**: If your miners are on a different subnet than your Umbrel, enter the subnet prefix (e.g., `192.168.2`) in Settings
- **Pair New Device**: Opens a 10-minute pairing window so a new phone can bind (does not rotate the code)
- **Regenerate Code**: Generate a new pairing code and open a pairing window (requires re-pairing in the iOS app)
- **Disconnect / Unpair** (from the app): Clears the pinned device and rotates the pairing code so the old code stops working
