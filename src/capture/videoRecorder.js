'use strict';

const fs   = require('fs');
const path = require('path');
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
 * Records incoming MJPEG frames as H.264 .mp4 segments.
 * Segments are stored as: segments/<YYYY-MM-DD>/<HH-MM-SS-mmm>.mp4
 *
 * Each segment runs for config.segmentDurationSeconds wall-clock seconds,
 * then ffmpeg is gracefully closed (stdin EOF) and a new process is spawned.
 * Frames written during the brief rotation gap (~50ms) are silently dropped.
 */
class VideoSegmentRecorder {
  constructor() {
    this.running       = false;
    this._process      = null;
    this._stdin        = null;
    this._rotateTimer  = null;
  }

  start() {
    this.running = true;
    this._record();
    console.log(
      `[VideoRecorder] Recording started: segment=${config.segmentDurationSeconds}s` +
      ` dir="${config.segmentsDir}"`
    );
  }

  stop() {
    this.running = false;
    clearTimeout(this._rotateTimer);
    this._endCurrentSegment();
  }

  /**
   * Write a single MJPEG frame buffer into the current segment's stdin pipe.
   * Silently ignored during rotation gaps.
   */
  writeFrame(buffer) {
    if (!this._stdin || this._stdin.destroyed) return;
    try {
      this._stdin.write(buffer);
    } catch {
      // stdin may close mid-rotation; next frame goes to the new process
    }
  }

  // ─── private ────────────────────────────────────────────────────────────────

  _endCurrentSegment() {
    if (this._stdin && !this._stdin.destroyed) {
      try { this._stdin.end(); } catch { /* ignore */ }
    }
    this._stdin   = null;
    this._process = null;
  }

  _record() {
    if (!this.running) return;

    const now     = new Date();
    const dateDir = path.join(config.segmentsDir, getDateString(now));
    fs.mkdirSync(dateDir, { recursive: true });
    const outPath = path.join(dateDir, `${getSegmentName(now)}.mp4`);

    // Input: raw MJPEG frames piped one-by-one; each is a complete JPEG buffer.
    // -use_wallclock_as_timestamps replaces ffmpeg's frame-count-based PTS with the
    // actual wall-clock time each frame arrived at the pipe. Without this, if the
    // real delivery rate drifts below the declared framerate (pipeline jitter, dshow
    // timing), the video plays faster than real time and inpoint/outpoint seek to the
    // wrong positions in clips.js.
    const proc = spawn('ffmpeg', [
      '-use_wallclock_as_timestamps', '1',
      '-f',         'image2pipe',
      '-vcodec',    'mjpeg',
      '-framerate', String(config.segmentFps), // hint only; actual PTS from wallclock
      '-i',         'pipe:0',
      '-c:v',       'libx264',
      '-crf',       '23',
      '-preset',    'fast',
      '-pix_fmt',   'yuv420p',
      '-r',         String(config.segmentFps),
      '-g',         '30',          // keyframe every 2s at 15fps; limits seek inaccuracy to ≤2s
      '-tune',      'film',        // optimise for natural motion content
      '-movflags',  '+faststart',  // moov at front → seekable during concat
      '-y',         outPath,
    ], { stdio: ['pipe', 'ignore', 'pipe'] });

    this._process = proc;
    this._stdin   = proc.stdin;

    let stderr = '';
    proc.stderr.on('data', (d) => { stderr += d.toString(); });

    proc.on('error', (err) => {
      console.error('[VideoRecorder] ffmpeg spawn error:', err.message);
      if (this.running) setTimeout(() => this._record(), 5000);
    });

    proc.on('close', (code) => {
      if (!this.running) return;
      if (code !== 0 && code !== null) {
        console.warn(`[VideoRecorder] Segment closed with code ${code}.`);
        if (stderr) console.debug('[VideoRecorder] stderr:', stderr.slice(-400));
        // Retry after a short delay so we don't tight-loop on persistent errors
        setTimeout(() => this._record(), 3000);
      } else {
        console.log(`[VideoRecorder] Segment saved: ${outPath}`);
      }
    });

    // Rotate: close stdin after the configured duration so ffmpeg flushes and
    // finalises the file, then immediately start the next segment.
    this._rotateTimer = setTimeout(() => {
      this._endCurrentSegment();
      this._record();
    }, config.segmentDurationSeconds * 1000);
  }
}

module.exports = VideoSegmentRecorder;
