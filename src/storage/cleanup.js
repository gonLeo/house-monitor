'use strict';

const fs   = require('fs');
const path = require('path');
const cron = require('node-cron');
const config = require('../config');
const ntfy   = require('../notifications/ntfy');
const db     = require('../db/queries');

function start() {
  // Run every retentionHours hours and wipe all media files + DB records
  const cronExpr = `0 */${config.retentionHours} * * *`;
  cron.schedule(cronExpr, async () => {
    const seg   = cleanAllSegments();
    const audio = cleanAllAudio();
    const snaps = cleanAllSnapshots();
    cleanAllLogs();
    await cleanAllDbRecords();

    const totalBytes = seg.bytes + audio.bytes + snaps.bytes;
    const totalFiles = seg.files + audio.files + snaps.files;

    ntfy.cleanupDone({
      removedBytes:   totalBytes,
      filesCount:     totalFiles,
      retentionHours: config.retentionHours,
    });
  });
  console.log(
    `[Cleanup] Scheduled cleanup every ${config.retentionHours}h (${cronExpr}) — deletes all media files.`
  );
}

function cleanAllSegments() {
  const segDir = config.segmentsDir;
  if (!fs.existsSync(segDir)) return { bytes: 0, files: 0 };

  let deletedCount = 0;
  let deletedBytes = 0;

  for (const dateDir of fs.readdirSync(segDir)) {
    const dirPath = path.join(segDir, dateDir);
    if (!fs.statSync(dirPath).isDirectory()) continue;
    for (const file of fs.readdirSync(dirPath)) {
      const filePath = path.join(dirPath, file);
      try {
        deletedBytes += fs.statSync(filePath).size;
        fs.unlinkSync(filePath);
        deletedCount++;
      } catch { /* ignore */ }
    }
    try { fs.rmdirSync(dirPath); } catch { /* ignore */ }
  }

  if (deletedCount > 0) {
    console.log(`[Cleanup] Deleted ${deletedCount} video segment(s).`);
  }
  return { bytes: deletedBytes, files: deletedCount };
}

function cleanAllSnapshots() {
  const snapDir = config.snapshotsDir;
  if (!snapDir || !fs.existsSync(snapDir)) return { bytes: 0, files: 0 };

  let deletedCount = 0;
  let deletedBytes = 0;

  for (const file of fs.readdirSync(snapDir)) {
    const filePath = path.join(snapDir, file);
    try {
      if (!fs.statSync(filePath).isFile()) continue;
      deletedBytes += fs.statSync(filePath).size;
      fs.unlinkSync(filePath);
      deletedCount++;
    } catch { /* ignore */ }
  }

  if (deletedCount > 0) {
    console.log(`[Cleanup] Deleted ${deletedCount} snapshot(s).`);
  }
  return { bytes: deletedBytes, files: deletedCount };
}

function cleanAllAudio() {
  const audioDir = config.audioDir;
  if (!audioDir || !fs.existsSync(audioDir)) return { bytes: 0, files: 0 };

  let deletedCount = 0;
  let deletedBytes = 0;

  for (const dateDir of fs.readdirSync(audioDir)) {
    const dirPath = path.join(audioDir, dateDir);
    if (!fs.statSync(dirPath).isDirectory()) continue;
    for (const file of fs.readdirSync(dirPath)) {
      const filePath = path.join(dirPath, file);
      try {
        deletedBytes += fs.statSync(filePath).size;
        fs.unlinkSync(filePath);
        deletedCount++;
      } catch { /* ignore */ }
    }
    try { fs.rmdirSync(dirPath); } catch { /* ignore */ }
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

function cleanAllLogs() {
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
  const seg   = cleanAllSegments();
  const audio = cleanAllAudio();
  const snaps = cleanAllSnapshots();
  cleanAllLogs();
  await cleanAllDbRecords();

  const totalBytes = seg.bytes + audio.bytes + snaps.bytes;
  const totalFiles = seg.files + audio.files + snaps.files;

  console.log(`[Cleanup] Manual cleanup triggered: ${totalFiles} file(s) removed.`);

  ntfy.cleanupDone({
    removedBytes:   totalBytes,
    filesCount:     totalFiles,
    retentionHours: config.retentionHours,
  });

  return { removedBytes: totalBytes, filesCount: totalFiles };
}

module.exports = { start, runCleanupNow };
