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

## Configuration

- **Custom Subnet**: If your miners are on a different subnet than your Umbrel, enter the subnet prefix (e.g., `192.168.2`) in Settings
- **Pair New Device**: Opens a 10-minute pairing window so a new phone can bind (does not rotate the code)
- **Regenerate Code**: Generate a new pairing code and open a pairing window (requires re-pairing in the iOS app)
- **Disconnect / Unpair** (from the app): Clears the pinned device and rotates the pairing code so the old code stops working
