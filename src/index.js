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
const motionDetector = require('./detection/motionDetector');
const PresenceTracker  = require('./detection/presenceTracker');
const MotionTracker = require('./detection/motionTracker');
const CameraCapture = require('./capture/camera');
const pipeline      = require('./capture/pipeline');
const VideoSegmentRecorder = require('./capture/videoRecorder');
const WsServer      = require('./streaming/wsServer');
const ConnectivityMonitor = require('./connectivity/monitor');
const storage       = require('./storage/files');
const cleanup       = require('./storage/cleanup');
const AudioRecorder = require('./capture/audioRecorder');
const { createServer } = require('./api/server');
const { startStorageCacheRefresh } = require('./api/routes');
const ntfy = require('./notifications/ntfy');
const alarm = require('./alarm');
const runtimeSettings = require('./settings/runtime');

async function main() {
  console.log('╔══════════════════════════════════╗');
  console.log('║        House Monitor MVP         ║');
  console.log('╚══════════════════════════════════╝');

  // Ensure storage directories exist
  fs.mkdirSync(config.snapshotsDir, { recursive: true });
  fs.mkdirSync(config.audioDir,     { recursive: true });
  fs.mkdirSync(config.segmentsDir,  { recursive: true });

  // 1. Connect to database (waits for Docker PostgreSQL to be ready)
  await waitForConnection();

  // 2. Apply schema migrations (idempotent)
  await runMigrations();

  // 3. Load persisted runtime settings before starting services
  const loadedSettings = await runtimeSettings.load(db);
  alarm.setEnabled(loadedSettings.alarmEnabled);
  ntfy.setEnabled(loadedSettings.notificationsEnabled);

  // Motion detection stays on a lightweight worker to preserve stream fluency.
  await motionDetector.load();

  // Human model is only loaded when required by the active mode.
  if (loadedSettings.detectionMode !== 'motion_only') {
    console.log('[App] Loading COCO-SSD model in worker thread…');
    await detector.load();
  } else {
    console.log('[App] Human detector will stay lazy-loaded until needed.');
  }

  // 4. Create HTTP server + Express app
  const camera          = new CameraCapture();
  const audioRecorder   = new AudioRecorder();
  const videoRecorder   = new VideoSegmentRecorder();
  const presenceTracker = new PresenceTracker(config.absenceThresholdSeconds * 1000);
  const motionTracker   = new MotionTracker({
    cooldownMs: loadedSettings.motion.cooldownSeconds * 1000,
    clipWindowMs: loadedSettings.motion.clipSecondsAfter * 1000,
    minConsecutiveDetections: loadedSettings.motion.consecutiveDetections,
  });
  const connectivity    = new ConnectivityMonitor();

  const app        = createServer(db, connectivity, camera);
  const httpServer = http.createServer(app);

  // 5. WebSocket server (shares port with HTTP)
  const wsServer = new WsServer(httpServer);

  // 6. Start background services
  cleanup.start();
  startStorageCacheRefresh();
  connectivity.start(db);

  // 7. Wire camera → pipeline
  pipeline.start({
    camera,
    wsServer,
    detector,
    motionDetector,
    presenceTracker,
    motionTracker,
    videoRecorder,
    db,
    storage,
    settings: runtimeSettings,
  });

  // Wire camera disconnect/reconnect notifications
  camera.on('disconnected', () => ntfy.cameraDisconnected());
  camera.on('reconnected',  ({ downtimeMs }) => ntfy.cameraReconnected({ downtimeMs }));

  camera.start();
  audioRecorder.start();
  videoRecorder.start();

  // 8. Start HTTP server
  httpServer.listen(config.port, () => {
    console.log(`[App] ✓ Server running  →  http://localhost:${config.port}`);
    console.log(`[App] Camera device    →  "${config.camera.device}"`);
    console.log(`[App] Frame capture    →  ${config.camera.fps} fps at ${config.camera.width}x${config.camera.height}`);
    console.log(`[App] Video segments   →  ${config.segmentDurationSeconds}s .mp4 files at ${config.segmentFps}fps → ${config.segmentsDir}`);
    console.log(`[App] Absence timeout  →  ${config.absenceThresholdSeconds}s without detection ends presence`);
    console.log(`[App] Retention        →  ${config.retentionHours}h`);
  });

  // 9. Graceful shutdown
  async function shutdown(signal) {
    console.log(`\n[App] ${signal} received. Shutting down…`);
    camera.stop();
    videoRecorder.stop();
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
