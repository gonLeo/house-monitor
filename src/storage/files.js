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

/**
 * Parse a segment start Date from the audio directory structure.
 * dateDir  : "YYYY-MM-DD"
 * fileName : "HH-MM-SS.m4a"
 */
function parseSegmentStart(dateDir, fileName) {
  try {
    const [y, mo, d] = dateDir.split('-').map(Number);
    const [h, mi, s] = fileName.replace('.m4a', '').split('-').map(Number);
    return new Date(y, mo - 1, d, h, mi, s, 0);
  } catch {
    return null;
  }
}

/**
 * Return audio segments (m4a files) whose time range overlaps [startTime, endTime].
 * Each entry: { filePath: string, segStart: Date, segEnd: Date }
 */
function getAudioSegmentsInRange(startTime, endTime) {
  const start      = new Date(startTime);
  const end        = new Date(endTime);
  const audioDir   = config.audioDir;
  const segSeconds = config.audio.segmentSeconds;

  if (!fs.existsSync(audioDir)) return [];

  const dateDirs = fs.readdirSync(audioDir).sort();
  const segments = [];

  const now = new Date();

  for (const dateDir of dateDirs) {
    const dirPath = path.join(audioDir, dateDir);
    if (!fs.statSync(dirPath).isDirectory()) continue;

    const dirStart = new Date(dateDir + 'T00:00:00');
    const dirEnd   = new Date(dateDir + 'T23:59:59.999');
    if (dirEnd < start || dirStart > end) continue;

    for (const fileName of fs.readdirSync(dirPath).sort()) {
      if (!fileName.endsWith('.m4a')) continue;
      const segStart = parseSegmentStart(dateDir, fileName);
      if (!segStart) continue;
      const segEnd = new Date(segStart.getTime() + segSeconds * 1000);
      // Skip segments still being recorded — moov atom not written until ffmpeg closes the file
      if (segEnd > now) continue;
      if (segEnd > start && segStart < end) {
        segments.push({ filePath: path.join(dirPath, fileName), segStart, segEnd });
      }
    }
  }

  return segments;
}

module.exports = { saveFrame, saveSnapshot, getFramesInRange, getAudioSegmentsInRange };
