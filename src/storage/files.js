'use strict';

const fs   = require('fs');
const path = require('path');
const config = require('../config');

function pad(n) {
  return String(n).padStart(2, '0');
}

function getDateString(date) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function getTimeString(date) {
  return (
    `${pad(date.getHours())}-${pad(date.getMinutes())}-` +
    `${pad(date.getSeconds())}-${String(date.getMilliseconds()).padStart(3, '0')}`
  );
}

function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

/**
 * Save a JPEG frame to frames/<YYYY-MM-DD>/<HH-MM-SS-mmm>.jpg
 * Returns a Promise (non-blocking write).
 */
function saveFrame(jpegBuffer, date) {
  const dateDir = path.join(config.framesDir, getDateString(date));
  ensureDir(dateDir);
  const filePath = path.join(dateDir, `${getTimeString(date)}.jpg`);
  return fs.promises.writeFile(filePath, jpegBuffer);
}

/**
 * Save a JPEG snapshot for a detected event.
 * Returns the saved file path.
 */
async function saveSnapshot(jpegBuffer, eventId) {
  ensureDir(config.snapshotsDir);
  const filePath = path.join(config.snapshotsDir, `event-${eventId}.jpg`);
  await fs.promises.writeFile(filePath, jpegBuffer);
  return filePath;
}

/**
 * Parse a date from the directory/filename structure used by saveFrame.
 * dateDir  : "YYYY-MM-DD"
 * fileName : "HH-MM-SS-mmm.jpg"
 */
function parseDateFromPath(dateDir, fileName) {
  try {
    const [y, mo, d]      = dateDir.split('-').map(Number);
    const base            = fileName.replace('.jpg', '');
    const [h, mi, s, ms]  = base.split('-').map(Number);
    return new Date(y, mo - 1, d, h, mi, s, ms);
  } catch {
    return null;
  }
}

/**
 * Return an ordered list of frame file paths within [startTime, endTime].
 */
async function getFramesInRange(startTime, endTime) {
  const start = new Date(startTime);
  const end   = new Date(endTime);
  const framesDir = config.framesDir;

  if (!fs.existsSync(framesDir)) return [];

  const dateDirs = fs.readdirSync(framesDir).sort();
  const files = [];

  for (const dateDir of dateDirs) {
    const dirPath = path.join(framesDir, dateDir);
    if (!fs.statSync(dirPath).isDirectory()) continue;

    // Skip date directories clearly outside the requested range
    const dirStart = new Date(dateDir + 'T00:00:00');
    const dirEnd   = new Date(dateDir + 'T23:59:59.999');
    if (dirEnd < start || dirStart > end) continue;

    const frameFiles = fs.readdirSync(dirPath).sort();
    for (const fileName of frameFiles) {
      if (!fileName.endsWith('.jpg')) continue;
      const frameDate = parseDateFromPath(dateDir, fileName);
      if (!frameDate) continue;
      if (frameDate >= start && frameDate <= end) {
        files.push(path.join(dirPath, fileName));
      }
    }
  }

  return files;
}

module.exports = { saveFrame, saveSnapshot, getFramesInRange };
