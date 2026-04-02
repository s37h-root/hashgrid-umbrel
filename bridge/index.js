'use strict';

const { BridgeManager } = require('./BridgeManager');
const { createServer } = require('./server');

const PORT = parseInt(process.env.PORT, 10) || 3000;

const manager = new BridgeManager();
manager.start();

const app = createServer(manager);
app.listen(PORT, '0.0.0.0', () => {
  console.log(`[Bridge] Web UI: http://localhost:${PORT}`);
});

process.on('SIGTERM', () => {
  console.log('[Bridge] Shutting down...');
  manager.stop();
  process.exit(0);
});

process.on('SIGINT', () => {
  console.log('[Bridge] Shutting down...');
  manager.stop();
  process.exit(0);
});
