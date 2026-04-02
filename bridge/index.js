'use strict';

const { BridgeManager } = require('./BridgeManager');
const { createServer } = require('./server');

const PORT = parseInt(process.env.PORT, 10) || 3000;

const manager = new BridgeManager();
manager.start();

const app = createServer(manager);
const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`[Bridge] Web UI: http://localhost:${PORT}`);
});

function shutdown() {
  console.log('[Bridge] Shutting down...');
  manager.stop();
  server.close(() => process.exit(0));
  // Force exit after 5s if server doesn't close cleanly
  setTimeout(() => process.exit(0), 5000).unref();
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
