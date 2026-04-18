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
    this.running      = false;
    this._process     = null;
    this._stdin       = null;
    this._rotateTimer = null;
    this._segmentInfo = null;
  }

  start() {
    this.running = true;
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
   * The ffmpeg segment is spawned lazily on the first real frame so empty/invalid
   * MP4s are not created during camera startup gaps or reconnects.
   */
  writeFrame(buffer) {
    if (!this.running) return;

    if (!this._stdin || this._stdin.destroyed) {
      this._record();
      if (!this._stdin || this._stdin.destroyed) return;
    }

    if (this._segmentInfo) this._segmentInfo.framesWritten++;

    try {
      this._stdin.write(buffer);
    } catch {
      // stdin may close mid-rotation; the next frame will reopen the segment
    }
  }

  // ─── private ────────────────────────────────────────────────────────────────

  _endCurrentSegment() {
    clearTimeout(this._rotateTimer);
    this._rotateTimer = null;

    const stdin = this._stdin;
    this._stdin = null;
    this._process = null;
    this._segmentInfo = null;

    if (stdin && !stdin.destroyed) {
      try { stdin.end(); } catch { /* ignore */ }
    }
  }

  _record() {
    if (!this.running) return;
    if (this._stdin && !this._stdin.destroyed) return;

    const now     = new Date();
    const dateDir = path.join(config.segmentsDir, getDateString(now));
    fs.mkdirSync(dateDir, { recursive: true });
    const outPath = path.join(dateDir, `${getSegmentName(now)}.mp4`);
    const segmentInfo = { outPath, framesWritten: 0 };

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
      '-g',         '15',          // keyframe every 1s at 15fps; smoother clip starts/seeks
      '-keyint_min','15',
      '-tune',      'film',        // optimise for natural motion content
      '-movflags',  '+faststart',  // moov at front → seekable during concat
      '-y',         outPath,
    ], { stdio: ['pipe', 'ignore', 'pipe'] });

    this._process = proc;
    this._stdin = proc.stdin;
    this._segmentInfo = segmentInfo;

    let stderr = '';
    proc.stderr.on('data', (d) => { stderr += d.toString(); });

    proc.on('error', (err) => {
      console.error('[VideoRecorder] ffmpeg spawn error:', err.message);
      if (this.running) setTimeout(() => this._record(), 5000);
    });

    proc.on('close', (code) => {
      const hadFrames = segmentInfo.framesWritten > 0;

      if (fs.existsSync(outPath)) {
        try {
          const stat = fs.statSync(outPath);
          if (!hadFrames || stat.size === 0) {
            fs.unlinkSync(outPath);
          }
        } catch { /* ignore */ }
      }

      if (!hadFrames) {
        console.log(`[VideoRecorder] Empty segment skipped: ${outPath}`);
        return;
      }

      if (!this.running) return;
      if (code !== 0 && code !== null) {
        console.warn(`[VideoRecorder] Segment closed with code ${code}.`);
        if (stderr) console.debug('[VideoRecorder] stderr:', stderr.slice(-400));
        setTimeout(() => this._record(), 1000);
      } else {
        console.log(`[VideoRecorder] Segment saved: ${outPath}`);
      }
    });

    // Rotate: close stdin after the configured duration so ffmpeg flushes and
    // finalises the file. The next real frame will open the following segment.
    this._rotateTimer = setTimeout(() => {
      this._endCurrentSegment();
    }, config.segmentDurationSeconds * 1000);
  }
}

module.exports = VideoSegmentRecorder;
