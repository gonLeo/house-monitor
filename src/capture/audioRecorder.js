'use strict';

const fs     = require('fs');
const path   = require('path');
const { spawn } = require('child_process');
const config = require('../config');

function pad(n) { return String(n).padStart(2, '0'); }

function getDateString(d) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function getSegmentName(d) {
  const ms = String(d.getMilliseconds()).padStart(3, '0');
  return `${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}-${ms}`;
}

/**
 * Records audio from a DirectShow microphone in fixed-duration segments.
 * Segments are stored as: audio/<YYYY-MM-DD>/<HH-MM-SS-mmm>.m4a
 *
 * Disabled automatically when config.audio.device is empty.
 *
 * Rotation is self-managed via the ffmpeg -t flag: each ffmpeg process runs for
 * exactly segmentSeconds of audio samples, then exits cleanly (writing the moov
 * atom). The next segment spawns immediately in the 'close' handler.
 *
 * NOTE: stdin.end() does NOT stop a DirectShow-capturing ffmpeg on Windows
 * because dshow ignores stdin EOF. Using -t is the only reliable way to
 * ensure the moov atom is written and the file is valid for later use.
 */
class AudioRecorder {
  constructor() {
    this.running  = false;
    this._process = null;
  }

  start() {
    if (this.running) return;
    if (!config.audio.device) {
      console.log('[Audio] AUDIO_DEVICE not configured — audio recording disabled.');
      return;
    }
    this.running = true;
    this._record();
    console.log(
      `[Audio] Recording started: device="${config.audio.device}" ` +
      `segment=${config.audio.segmentSeconds}s bitrate=${config.audio.bitrate}`
    );
  }

  stop() {
    const proc = this._process;
    this.running = false;
    this._process = null;

    if (!proc || proc.exitCode !== null || proc.killed) {
      return Promise.resolve();
    }

    return new Promise((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        resolve();
      };

      proc.once('close', finish);
      proc.once('error', finish);

      try {
        proc.kill('SIGTERM');
      } catch {
        finish();
        return;
      }

      setTimeout(() => {
        try {
          if (proc.exitCode === null && !proc.killed) proc.kill('SIGKILL');
        } catch { /* ignore */ }
        finish();
      }, 5000);
    });
  }

  _record() {
    if (!this.running) return;

    const now     = new Date();
    const dateDir = path.join(config.audioDir, getDateString(now));
    fs.mkdirSync(dateDir, { recursive: true });
    const outPath = path.join(dateDir, `${getSegmentName(now)}.m4a`);

    this._process = spawn('ffmpeg', [
      '-f',   'dshow',
      '-i',   `audio=${config.audio.device}`,
      '-c:a', 'aac',
      '-b:a', config.audio.bitrate,
      '-t',   String(config.audio.segmentSeconds),
      '-y',
      outPath,
    ], { stdio: ['ignore', 'ignore', 'pipe'] });

    let stderr = '';
    this._process.stderr.on('data', (d) => {
      if (stderr.length < 4096) stderr += d.toString();
    });

    this._process.on('error', (err) => {
      console.error('[Audio] ffmpeg spawn error:', err.message);
      if (this.running) setTimeout(() => this._record(), 5000);
    });

    this._process.on('close', (code) => {
      if (!this.running) return;
      if (code !== 0) {
        console.warn(`[Audio] Segment ended with code ${code}. Retrying in 3s…`);
        if (stderr) console.warn('[Audio]', stderr.slice(-400));
        setTimeout(() => this._record(), 3000);
      } else {
        // Immediately start next segment
        setImmediate(() => this._record());
      }
    });
  }
}

module.exports = AudioRecorder;
