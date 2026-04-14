'use strict';

require('dotenv').config();

const config = require('./config');
const logger = require('./logger');
logger.init(config.logsDir); // intercepts console.log/warn/error → logs/app.log

const http = require('http');
const fs   = require('fs');

const { waitForConnection } = require('./db/connection');
const { runMigrations }     = require('./db/migrations');
const db           = require('./db/queries');
const detector     = require('./detection/detector');
const CooldownTimer = require('./detection/cooldown');
const CameraCapture = require('./capture/camera');
const pipeline      = require('./capture/pipeline');
const WsServer      = require('./streaming/wsServer');
const ConnectivityMonitor = require('./connectivity/monitor');
const storage       = require('./storage/files');
const cleanup       = require('./storage/cleanup');
const AudioRecorder = require('./capture/audioRecorder');
const { createServer } = require('./api/server');

async function main() {
  console.log('╔══════════════════════════════════╗');
  console.log('║        House Monitor MVP         ║');
  console.log('╚══════════════════════════════════╝');

  // Ensure storage directories exist
  fs.mkdirSync(config.framesDir,    { recursive: true });
  fs.mkdirSync(config.snapshotsDir, { recursive: true });
  fs.mkdirSync(config.audioDir,     { recursive: true });

  // 1. Connect to database (waits for Docker PostgreSQL to be ready)
  await waitForConnection();

  // 2. Apply schema migrations (idempotent)
  await runMigrations();

  // 3. Load COCO-SSD detection model (runs in a Worker Thread)
  console.log('[App] Loading COCO-SSD model in worker thread…');
  await detector.load();

  // 4. Create HTTP server + Express app
  const camera         = new CameraCapture();
  const audioRecorder  = new AudioRecorder();
  const cooldown       = new CooldownTimer(config.cooldownSeconds * 1000);
  const connectivity   = new ConnectivityMonitor();

  const app        = createServer(db, connectivity, camera);
  const httpServer = http.createServer(app);

  // 5. WebSocket server (shares port with HTTP)
  const wsServer = new WsServer(httpServer);

  // 6. Start background services
  cleanup.start();
  connectivity.start(db);

  // 7. Wire camera → pipeline
  pipeline.start({ camera, wsServer, detector, cooldown, db, storage });
  camera.start();
  audioRecorder.start();

  // 8. Start HTTP server
  httpServer.listen(config.port, () => {
    console.log(`[App] ✓ Server running  →  http://localhost:${config.port}`);
    console.log(`[App] Camera device    →  "${config.camera.device}"`);
    console.log(`[App] Frame capture    →  ${config.camera.fps} fps at ${config.camera.width}x${config.camera.height}`);
    console.log(`[App] Cooldown         →  ${config.cooldownSeconds}s between alerts`);
    console.log(`[App] Frames stored at →  ${config.framesDir} (deleted after ${config.frameRetentionHours}h)`);
  });

  // 9. Graceful shutdown
  async function shutdown(signal) {
    console.log(`\n[App] ${signal} received. Shutting down…`);
    camera.stop();
    audioRecorder.stop();
    connectivity.stop();
    httpServer.close(async () => {
      const { pool } = require('./db/connection');
      await pool.end();
      console.log('[App] Shutdown complete.');
      process.exit(0);
    });
  }

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT',  () => shutdown('SIGINT'));
}

main().catch((err) => {
  console.error('[App] Fatal startup error:', err.message);
  process.exit(1);
});
