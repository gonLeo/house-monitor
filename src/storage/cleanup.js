'use strict';

const fs   = require('fs');
const path = require('path');
const config = require('../config');
const ntfy   = require('../notifications/ntfy');
const db     = require('../db/queries');

let captureControllers = {
  videoRecorder: null,
  audioRecorder: null,
};
let cleanupInFlight = null;
let cleanupTimer = null;

function setCaptureControllers({ videoRecorder = null, audioRecorder = null } = {}) {
  captureControllers = { videoRecorder, audioRecorder };
}

async function pauseActiveCaptures() {
  const paused = [];

  for (const [label, recorder] of [
    ['video', captureControllers.videoRecorder],
    ['audio', captureControllers.audioRecorder],
  ]) {
    if (!recorder || !recorder.running || typeof recorder.stop !== 'function') continue;

    console.log(`[Cleanup] Pausing ${label} capture before deletion…`);
    try {
      await recorder.stop();
      paused.push({ label, recorder });
    } catch (err) {
      console.warn(`[Cleanup] Failed to pause ${label} capture:`, err.message);
    }
  }

  return paused;
}

function resumeCaptures(paused) {
  for (const { label, recorder } of paused) {
    if (!recorder || typeof recorder.start !== 'function') continue;
    try {
      recorder.start();
      console.log(`[Cleanup] Resumed ${label} capture after cleanup.`);
    } catch (err) {
      console.warn(`[Cleanup] Failed to resume ${label} capture:`, err.message);
    }
  }
}

async function performCleanup(reason = 'manual') {
  if (cleanupInFlight) {
    console.log('[Cleanup] Cleanup already in progress; reusing the current run.');
    return cleanupInFlight;
  }

  cleanupInFlight = (async () => {
    const paused = await pauseActiveCaptures();
    try {
      const [seg, audio, snaps] = await Promise.all([
        cleanAllSegments(),
        cleanAllAudio(),
        cleanAllSnapshots(),
      ]);
      await cleanAllDbRecords();
      await cleanAllLogs();
      const totalFiles = seg.files + audio.files + snaps.files;
      const totalBytes = seg.bytes + audio.bytes + snaps.bytes;
      const label = reason === 'scheduled' ? 'Scheduled' : 'Manual';

      console.log(`[Cleanup] ${label} cleanup triggered: ${totalFiles} file(s) removed.`);

      ntfy.cleanupDone({
        removedBytes:   totalBytes,
        filesCount:     totalFiles,
        retentionHours: config.retentionHours,
      });

      return { removedBytes: totalBytes, filesCount: totalFiles };
    } finally {
      resumeCaptures(paused);
      cleanupInFlight = null;
    }
  })();

  return cleanupInFlight;
}

function start() {
  const hours = Math.max(1, config.retentionHours);
  const intervalMs = hours * 60 * 60 * 1000;

  if (cleanupTimer) {
    clearInterval(cleanupTimer);
  }

  cleanupTimer = setInterval(() => {
    performCleanup('scheduled').catch((err) => {
      console.error('[Cleanup] Scheduled cleanup failed:', err.message);
    });
  }, intervalMs);

  if (typeof cleanupTimer.unref === 'function') {
    cleanupTimer.unref();
  }

  const nextRun = new Date(Date.now() + intervalMs);
  console.log(
    `[Cleanup] Scheduled cleanup every ${hours}h from app start. ` +
    `Next run around ${nextRun.toLocaleString()}.`
  );
}

async function cleanAllSegments() {
  const segDir = config.segmentsDir;
  if (!fs.existsSync(segDir)) return { bytes: 0, files: 0 };

  let deletedCount = 0;
  let deletedBytes = 0;

  for (const dateDir of await fs.promises.readdir(segDir)) {
    const dirPath = path.join(segDir, dateDir);
    let dirStat;
    try { dirStat = await fs.promises.stat(dirPath); } catch { continue; }
    if (!dirStat.isDirectory()) continue;
    for (const file of await fs.promises.readdir(dirPath)) {
      const filePath = path.join(dirPath, file);
      try {
        const stat = await fs.promises.stat(filePath);
        deletedBytes += stat.size;
        await fs.promises.unlink(filePath);
        deletedCount++;
      } catch { /* ignore */ }
    }
    try { await fs.promises.rmdir(dirPath); } catch { /* ignore */ }
  }

  if (deletedCount > 0) {
    console.log(`[Cleanup] Deleted ${deletedCount} video segment(s).`);
  }
  return { bytes: deletedBytes, files: deletedCount };
}

async function cleanAllSnapshots() {
  const snapDir = config.snapshotsDir;
  if (!snapDir || !fs.existsSync(snapDir)) return { bytes: 0, files: 0 };

  let deletedCount = 0;
  let deletedBytes = 0;

  for (const file of await fs.promises.readdir(snapDir)) {
    const filePath = path.join(snapDir, file);
    try {
      const stat = await fs.promises.stat(filePath);
      if (!stat.isFile()) continue;
      deletedBytes += stat.size;
      await fs.promises.unlink(filePath);
      deletedCount++;
    } catch { /* ignore */ }
  }

  if (deletedCount > 0) {
    console.log(`[Cleanup] Deleted ${deletedCount} snapshot(s).`);
  }
  return { bytes: deletedBytes, files: deletedCount };
}

async function cleanAllAudio() {
  const audioDir = config.audioDir;
  if (!audioDir || !fs.existsSync(audioDir)) return { bytes: 0, files: 0 };

  let deletedCount = 0;
  let deletedBytes = 0;

  for (const dateDir of await fs.promises.readdir(audioDir)) {
    const dirPath = path.join(audioDir, dateDir);
    let dirStat;
    try { dirStat = await fs.promises.stat(dirPath); } catch { continue; }
    if (!dirStat.isDirectory()) continue;
    for (const file of await fs.promises.readdir(dirPath)) {
      const filePath = path.join(dirPath, file);
      try {
        const stat = await fs.promises.stat(filePath);
        deletedBytes += stat.size;
        await fs.promises.unlink(filePath);
        deletedCount++;
      } catch { /* ignore */ }
    }
    try { await fs.promises.rmdir(dirPath); } catch { /* ignore */ }
  }

  if (deletedCount > 0) {
    console.log(`[Cleanup] Deleted ${deletedCount} audio segment(s).`);
  }
  return { bytes: deletedBytes, files: deletedCount };
}

async function cleanAllDbRecords() {
  try {
    const events = await db.deleteAllEvents();
    const logs   = await db.deleteAllConnectivityLogs();
    console.log(`[Cleanup] Deleted ${events} event(s) and ${logs} connectivity log(s) from DB.`);
  } catch (err) {
    console.error('[Cleanup] Failed to delete DB records:', err.message);
  }
}

async function cleanAllLogs() {
  const logsDir = config.logsDir;
  if (!logsDir) return;
  const filePath = path.join(logsDir, 'app.log');
  if (!fs.existsSync(filePath)) return;
  try {
    fs.writeFileSync(filePath, '', 'utf8');
    console.log('[Cleanup] app.log truncated.');
  } catch { /* ignore */ }
}

async function runCleanupNow() {
  return performCleanup('manual');
}

module.exports = { start, runCleanupNow, setCaptureControllers };
