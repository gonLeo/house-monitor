'use strict';

const fs   = require('fs');
const path = require('path');
const cron = require('node-cron');
const config = require('../config');

function start() {
  // Run every hour at minute 0
  cron.schedule('0 * * * *', () => {
    cleanOldFrames();
    cleanOldAudio();
    cleanOldLogs();
  });
  console.log(
    `[Cleanup] Scheduled hourly frame cleanup (retention: ${config.frameRetentionHours}h).`
  );
}

function cleanOldFrames() {
  const framesDir = config.framesDir;
  if (!fs.existsSync(framesDir)) return;

  const cutoff = new Date(Date.now() - config.frameRetentionHours * 3600 * 1000);
  let deletedCount = 0;

  const dateDirs = fs.readdirSync(framesDir);

  for (const dateDir of dateDirs) {
    const dirPath = path.join(framesDir, dateDir);
    if (!fs.statSync(dirPath).isDirectory()) continue;

    // If the whole day is older than the cutoff, remove all files and the dir
    const dirEnd = new Date(dateDir + 'T23:59:59.999');
    if (dirEnd < cutoff) {
      for (const file of fs.readdirSync(dirPath)) {
        try { fs.unlinkSync(path.join(dirPath, file)); deletedCount++; } catch { /* ignore */ }
      }
      try { fs.rmdirSync(dirPath); } catch { /* ignore */ }
      continue;
    }

    // Otherwise check individual files within the day
    for (const fileName of fs.readdirSync(dirPath)) {
      if (!fileName.endsWith('.jpg')) continue;
      const [y, mo, d]     = dateDir.split('-').map(Number);
      const base           = fileName.replace('.jpg', '');
      const [h, mi, s, ms] = base.split('-').map(Number);
      const fileDate = new Date(y, mo - 1, d, h, mi, s, ms);
      if (isNaN(fileDate.getTime())) continue;
      if (fileDate < cutoff) {
        try { fs.unlinkSync(path.join(dirPath, fileName)); deletedCount++; } catch { /* ignore */ }
      }
    }
  }

  if (deletedCount > 0) {
    console.log(`[Cleanup] Deleted ${deletedCount} old frame(s).`);
  }
}

function cleanOldAudio() {
  const audioDir = config.audioDir;
  if (!audioDir || !fs.existsSync(audioDir)) return;

  const cutoff = new Date(Date.now() - config.frameRetentionHours * 3600 * 1000);
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

  const cutoff = new Date(Date.now() - config.frameRetentionHours * 3600 * 1000);

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
