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

function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
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
 * Parse a date from the directory/filename structure used by VideoSegmentRecorder.
 * dateDir  : "YYYY-MM-DD"
 * fileName : "HH-MM-SS.mp4" (legacy) or "HH-MM-SS-mmm.mp4" (current)
 */
function parseSegmentDate(dateDir, fileName) {
  try {
    const [y, mo, d] = dateDir.split('-').map(Number);
    const parts = fileName.replace('.mp4', '').split('-').map(Number);
    const [h, mi, s] = parts;
    const ms = parts.length >= 4 ? parts[3] : 0;
    return new Date(y, mo - 1, d, h, mi, s, ms);
  } catch {
    return null;
  }
}

/**
 * Return video segments (.mp4) whose time range overlaps [startTime, endTime].
 * Each entry: { filePath: string, segStart: Date, segEnd: Date }
 * Segments currently being recorded (segEnd > now) are excluded — the file's
 * moov atom is not written until ffmpeg closes it.
 */
function getVideoSegmentsInRange(startTime, endTime) {
  const start      = new Date(startTime);
  const end        = new Date(endTime);
  const segDirRoot = config.segmentsDir;
  const segSeconds = config.segmentDurationSeconds;

  if (!fs.existsSync(segDirRoot)) return [];

  const now      = new Date();
  const dateDirs = fs.readdirSync(segDirRoot).sort();
  const segments = [];

  for (const dateDir of dateDirs) {
    const dirPath = path.join(segDirRoot, dateDir);
    if (!fs.statSync(dirPath).isDirectory()) continue;

    const dirStart = new Date(dateDir + 'T00:00:00');
    const dirEnd   = new Date(dateDir + 'T23:59:59.999');
    if (dirEnd < start || dirStart > end) continue;

    for (const fileName of fs.readdirSync(dirPath).sort()) {
      if (!fileName.endsWith('.mp4')) continue;
      const segStart = parseSegmentDate(dateDir, fileName);
      if (!segStart) continue;
      const segEnd = new Date(segStart.getTime() + segSeconds * 1000);
      // Skip segments still being recorded
      if (segEnd > now) continue;
      if (segEnd > start && segStart < end) {
        segments.push({ filePath: path.join(dirPath, fileName), segStart, segEnd });
      }
    }
  }

  return segments;
}

/**
 * Parse a segment start Date from the audio directory structure.
 * dateDir  : "YYYY-MM-DD"
 * fileName : "HH-MM-SS.m4a" (legacy) or "HH-MM-SS-mmm.m4a" (current)
 */
function parseSegmentStart(dateDir, fileName) {
  try {
    const [y, mo, d] = dateDir.split('-').map(Number);
    const parts = fileName.replace('.m4a', '').split('-').map(Number);
    const [h, mi, s] = parts;
    const ms = parts.length >= 4 ? parts[3] : 0;
    return new Date(y, mo - 1, d, h, mi, s, ms);
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

module.exports = { saveSnapshot, getVideoSegmentsInRange, getAudioSegmentsInRange };
