'use strict';

const fs     = require('fs');
const path   = require('path');
const clips  = require('./clips');
const config = require('../config');
const alarm   = require('../alarm');
const ntfy    = require('../notifications/ntfy');
const cleanup = require('../storage/cleanup');
const db      = require('../db/queries');
const settingsStore = require('../settings/runtime');
const detector = require('../detection/detector');

// ── Storage usage cache ───────────────────────────────────────────────────────
const STORAGE_CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutes
const STORAGE_WARN_BYTES   = 25 * 1024 ** 3;  // 25 GB

let _storageCache     = null;  // { totalBytes, byDir, calculatedAt }
let _storageAlertSent = false; // true while usage stays >= 25 GB

function dirSizeSync(dirPath) {
  if (!fs.existsSync(dirPath)) return 0;
  let total = 0;
  for (const entry of fs.readdirSync(dirPath, { withFileTypes: true })) {
    const full = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      total += dirSizeSync(full);
    } else {
      try { total += fs.statSync(full).size; } catch { /* ignore */ }
    }
  }
  return total;
}

function computeStorageUsage() {
  const dirs = {
    'Segmentos': config.segmentsDir,
    'Frames':    config.framesDir,
    'Audio':     config.audioDir,
    'Snapshots': config.snapshotsDir,
    'Logs':      config.logsDir,
  };
  const byDir = {};
  let totalBytes = 0;
  for (const [label, dirPath] of Object.entries(dirs)) {
    const bytes = dirSizeSync(path.resolve(process.cwd(), dirPath));
    byDir[label] = bytes;
    totalBytes += bytes;
  }
  _storageCache = { totalBytes, byDir, calculatedAt: new Date().toISOString() };
  checkStorageThreshold(totalBytes);
  return _storageCache;
}

async function checkStorageThreshold(totalBytes) {
  if (totalBytes >= STORAGE_WARN_BYTES) {
    if (!_storageAlertSent) {
      _storageAlertSent = true;
      try {
        const eventCount = await db.countAllEvents();
        ntfy.storageWarning({ totalBytes, eventCount });
      } catch (err) {
        console.warn('[Storage] Falha ao enviar alerta de armazenamento:', err.message);
      }
    }
  } else {
    _storageAlertSent = false;
  }
}

function startStorageCacheRefresh() {
  computeStorageUsage(); // initial
  setInterval(computeStorageUsage, STORAGE_CACHE_TTL_MS);
}

function setup(app, db, connectivity, camera) {

  // ------------------------------------------------------------------
  // GET /events?startTime=&endTime=&synced=&type=
  // ------------------------------------------------------------------
  app.get('/events', async (req, res) => {
    try {
      const { startTime, endTime, synced, type } = req.query;
      const events = await db.getEvents({ startTime, endTime, synced, type });
      res.json(events);
    } catch (err) {
      console.error('[API] GET /events:', err.message);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // ------------------------------------------------------------------
  // GET /snapshot/:id  — returns the JPEG snapshot for an event
  // ------------------------------------------------------------------
  app.get('/snapshot/:id', (req, res) => {
    // Accept only UUID-safe characters to prevent path traversal
    const id = req.params.id;
    if (!/^[0-9a-f-]+$/i.test(id)) {
      return res.status(400).json({ error: 'Invalid snapshot ID' });
    }
    const filePath = path.resolve(process.cwd(), config.snapshotsDir, `event-${id}.jpg`);
    res.sendFile(filePath, (err) => {
      if (err && !res.headersSent) {
        res.status(404).json({ error: 'Snapshot not found' });
      }
    });
  });

  // ------------------------------------------------------------------
  // GET /status  — system health summary
  // ------------------------------------------------------------------
  app.get('/status', async (req, res) => {
    try {
      const [lastEvent, connectivityHistory] = await Promise.all([
        db.getLastEvent(),
        db.getConnectivityLogs(10),
      ]);
      res.json({
        connectivity:       connectivity.getStatus(),
        cameraRunning:      camera.running,
        uptimeSeconds:      Math.floor(process.uptime()),
        retentionHours:     config.retentionHours,
        lastEvent,
        connectivityHistory,
      });
    } catch (err) {
      console.error('[API] GET /status:', err.message);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // ------------------------------------------------------------------
  // GET /clip?startTime=&endTime=  — generates and streams an MP4 clip
  // ------------------------------------------------------------------
  app.get('/clip', async (req, res) => {
    const { startTime, endTime } = req.query;
    if (!startTime || !endTime) {
      return res.status(400).json({ error: 'startTime and endTime query params are required' });
    }
    try {
      await clips.generate(startTime, endTime, res);
    } catch (err) {
      console.error('[API] GET /clip:', err.message);
      if (!res.headersSent) {
        res.status(500).json({ error: 'Failed to generate clip' });
      }
    }
  });

  // ------------------------------------------------------------------
  // GET /api/settings — current persisted runtime settings
  // POST /api/settings — patch and persist settings
  // ------------------------------------------------------------------
  app.get('/api/settings', (req, res) => {
    res.json(settingsStore.get());
  });

  app.post('/api/settings', async (req, res) => {
    try {
      const updated = await settingsStore.update(db, req.body ?? {});
      alarm.setEnabled(updated.alarmEnabled);
      ntfy.setEnabled(updated.notificationsEnabled);
      res.json(updated);
    } catch (err) {
      console.error('[API] POST /api/settings:', err.message);
      res.status(500).json({ error: 'Failed to persist settings' });
    }
  });

  // ------------------------------------------------------------------
  // GET /api/alarm  — returns alarm enabled state
  // POST /api/alarm  — sets alarm enabled state { enabled: true/false }
  // ------------------------------------------------------------------
  app.get('/api/alarm', (req, res) => {
    res.json({ enabled: alarm.isEnabled() });
  });

  app.post('/api/alarm', async (req, res) => {
    const { enabled } = req.body ?? {};
    if (typeof enabled !== 'boolean') {
      return res.status(400).json({ error: 'Body must be { "enabled": true|false }' });
    }
    try {
      const updated = await settingsStore.update(db, { alarmEnabled: enabled });
      alarm.setEnabled(updated.alarmEnabled);
      res.json({ enabled: updated.alarmEnabled });
    } catch (err) {
      console.error('[API] POST /api/alarm:', err.message);
      res.status(500).json({ error: 'Failed to persist alarm preference' });
    }
  });

  // ------------------------------------------------------------------
  // GET /api/notifications  — returns notifications enabled state
  // POST /api/notifications — sets notifications enabled state { enabled: true|false }
  // ------------------------------------------------------------------
  app.get('/api/notifications', (req, res) => {
    res.json({ enabled: ntfy.isEnabled() });
  });

  app.post('/api/notifications', async (req, res) => {
    const { enabled } = req.body ?? {};
    if (typeof enabled !== 'boolean') {
      return res.status(400).json({ error: 'Body must be { "enabled": true|false }' });
    }
    try {
      const updated = await settingsStore.update(db, { notificationsEnabled: enabled });
      ntfy.setEnabled(updated.notificationsEnabled);
      res.json({ enabled: updated.notificationsEnabled });
    } catch (err) {
      console.error('[API] POST /api/notifications:', err.message);
      res.status(500).json({ error: 'Failed to persist notifications preference' });
    }
  });

  // ------------------------------------------------------------------
  // GET /api/detection-mode  — returns current detection mode
  // POST /api/detection-mode — sets mode { mode: motion_only|motion_and_human|human_only }
  // ------------------------------------------------------------------
  app.get('/api/detection-mode', (req, res) => {
    res.json({ mode: settingsStore.get().detectionMode });
  });

  app.post('/api/detection-mode', async (req, res) => {
    const { mode } = req.body ?? {};
    if (!['motion_only', 'motion_and_human', 'human_only'].includes(mode)) {
      return res.status(400).json({ error: 'Invalid mode' });
    }
    try {
      const updated = await settingsStore.update(db, { detectionMode: mode });
      if (updated.detectionMode !== 'motion_only') {
        detector.load().catch((err) => {
          console.warn('[API] Background human detector load failed:', err.message);
        });
      }
      res.json({ mode: updated.detectionMode });
    } catch (err) {
      console.error('[API] POST /api/detection-mode:', err.message);
      res.status(500).json({ error: 'Failed to persist detection mode' });
    }
  });

  // ------------------------------------------------------------------
  // POST /api/motion-roi — persists the motion monitoring rectangle
  // ------------------------------------------------------------------
  app.post('/api/motion-roi', async (req, res) => {
    const { roi } = req.body ?? {};
    if (!roi || typeof roi !== 'object') {
      return res.status(400).json({ error: 'Body must be { roi: { x, y, w, h } }' });
    }
    try {
      const updated = await settingsStore.update(db, { motion: { roi } });
      res.json({ roi: updated.motion.roi });
    } catch (err) {
      console.error('[API] POST /api/motion-roi:', err.message);
      res.status(500).json({ error: 'Failed to persist motion ROI' });
    }
  });

  // ------------------------------------------------------------------
  // GET /api/storage-usage  — returns disk usage across monitored dirs
  // POST /api/storage-usage/refresh — forces an immediate recount
  // ------------------------------------------------------------------
  app.get('/api/storage-usage', (req, res) => {
    res.json(_storageCache || computeStorageUsage());
  });

  app.post('/api/storage-usage/refresh', (req, res) => {
    res.json(computeStorageUsage());
  });

  // ------------------------------------------------------------------
  // POST /api/cleanup/run — triggers an immediate cleanup (same as cron)
  // ------------------------------------------------------------------
  app.post('/api/cleanup/run', async (req, res) => {
    const result = await cleanup.runCleanupNow();
    // Refresh storage cache right after so the UI reflects the freed space
    computeStorageUsage();
    res.json(result);
  });

  // ------------------------------------------------------------------
  // GET /api/logs  — returns the application log file as plain text
  // ------------------------------------------------------------------
  app.get('/api/logs', (req, res) => {
    const filePath = path.resolve(process.cwd(), config.logsDir, 'app.log');
    if (!fs.existsSync(filePath)) {
      return res.type('text/plain; charset=utf-8').send('Nenhum log disponível ainda.');
    }
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    fs.createReadStream(filePath).pipe(res);
  });
}

module.exports = { setup, startStorageCacheRefresh };
