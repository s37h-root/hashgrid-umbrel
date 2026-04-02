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
3. Add this store URL: `https://github.com/s37h-root/hashgrid-umbrel`
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
4. Your miners will appear in the app immediately

## Configuration

- **Custom Subnet**: If your miners are on a different subnet than your Umbrel, enter the subnet prefix (e.g., `192.168.2`) in Settings
- **Regenerate Code**: Generate a new pairing code if needed (requires re-pairing in the iOS app)
