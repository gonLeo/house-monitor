'use strict';

const fs   = require('fs');
const path = require('path');
const cron = require('node-cron');
const config = require('../config');

function start() {
  // Run every hour at minute 0
  cron.schedule('0 * * * *', () => {
    cleanOldSegments();
    cleanOldAudio();
    cleanOldLogs();
  });
  console.log(
    `[Cleanup] Scheduled hourly cleanup (retention: ${config.retentionHours}h).`
  );
}

function cleanOldSegments() {
  const segDir = config.segmentsDir;
  if (!fs.existsSync(segDir)) return;

  const cutoff     = new Date(Date.now() - config.retentionHours * 3600 * 1000);
  const segSeconds = config.segmentDurationSeconds;
  let deletedCount = 0;

  for (const dateDir of fs.readdirSync(segDir)) {
    const dirPath = path.join(segDir, dateDir);
    if (!fs.statSync(dirPath).isDirectory()) continue;

    // Quick-reject: whole day older than cutoff
    const dirEnd = new Date(dateDir + 'T23:59:59.999');
    if (dirEnd < cutoff) {
      for (const file of fs.readdirSync(dirPath)) {
        try { fs.unlinkSync(path.join(dirPath, file)); deletedCount++; } catch { /* ignore */ }
      }
      try { fs.rmdirSync(dirPath); } catch { /* ignore */ }
      continue;
    }

    for (const fileName of fs.readdirSync(dirPath)) {
      if (!fileName.endsWith('.mp4')) continue;
      const [y, mo, d] = dateDir.split('-').map(Number);
      const [h, mi, s] = fileName.replace('.mp4', '').split('-').map(Number);
      const segStart = new Date(y, mo - 1, d, h, mi, s, 0);
      if (isNaN(segStart.getTime())) continue;
      const segEnd = new Date(segStart.getTime() + segSeconds * 1000);
      if (segEnd < cutoff) {
        try { fs.unlinkSync(path.join(dirPath, fileName)); deletedCount++; } catch { /* ignore */ }
      }
    }
  }

  if (deletedCount > 0) {
    console.log(`[Cleanup] Deleted ${deletedCount} old video segment(s).`);
  }
}

function cleanOldAudio() {
  const audioDir = config.audioDir;
  if (!audioDir || !fs.existsSync(audioDir)) return;

    const cutoff = new Date(Date.now() - config.retentionHours * 3600 * 1000);
  let deletedCount = 0;

  for (const dateDir of fs.readdirSync(audioDir)) {
    const dirPath = path.join(audioDir, dateDir);
    if (!fs.statSync(dirPath).isDirectory()) continue;

    const dirEnd = new Date(dateDir + 'T23:59:59.999');
    if (dirEnd < cutoff) {
      for (const file of fs.readdirSync(dirPath)) {
        try { fs.unlinkSync(path.join(dirPath, file)); deletedCount++; } catch { /* ignore */ }
      }
      try { fs.rmdirSync(dirPath); } catch { /* ignore */ }
      continue;
    }

    for (const fileName of fs.readdirSync(dirPath)) {
      if (!fileName.endsWith('.m4a')) continue;
      const [y, mo, d] = dateDir.split('-').map(Number);
      const [h, mi, s] = fileName.replace('.m4a', '').split('-').map(Number);
      const fileDate = new Date(y, mo - 1, d, h, mi, s, 0);
      if (isNaN(fileDate.getTime())) continue;
      if (fileDate < cutoff) {
        try { fs.unlinkSync(path.join(dirPath, fileName)); deletedCount++; } catch { /* ignore */ }
      }
    }
  }

  if (deletedCount > 0) {
    console.log(`[Cleanup] Deleted ${deletedCount} old audio segment(s).`);
  }
}

function cleanOldLogs() {
  const logsDir = config.logsDir;
  if (!logsDir) return;

  const filePath = path.join(logsDir, 'app.log');
  if (!fs.existsSync(filePath)) return;

  const cutoff = new Date(Date.now() - config.retentionHours * 3600 * 1000);

  try {
    const content = fs.readFileSync(filePath, 'utf8');
    const lines   = content.split('\n');
    const kept    = lines.filter(line => {
      // Lines written by logger.js start with [ISO_TIMESTAMP]
      const m = line.match(/^\[(\d{4}-\d{2}-\d{2}T[\d:.]+Z)\]/);
      if (!m) return true; // keep lines without recognisable timestamp
      return new Date(m[1]) >= cutoff;
    });
    if (kept.length < lines.length) {
      fs.writeFileSync(filePath, kept.join('\n'), 'utf8');
      console.log(`[Cleanup] Trimmed ${lines.length - kept.length} old log line(s).`);
    }
  } catch { /* ignore */ }
}

module.exports = { start };
