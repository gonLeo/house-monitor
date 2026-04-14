'use strict';

const { EventEmitter } = require('events');
const { spawn }        = require('child_process');
const config           = require('../config');

const JPEG_SOI = Buffer.from([0xFF, 0xD8]);
const JPEG_EOI = Buffer.from([0xFF, 0xD9]);
const MAX_RECONNECT_DELAY_MS = 30000;

/**
 * Captures JPEG frames from a DirectShow webcam via ffmpeg.
 * Emits 'frame' (Buffer) events for each complete JPEG.
 * Reconnects automatically with exponential backoff on failure.
 */
class CameraCapture extends EventEmitter {
  constructor() {
    super();
    this._process       = null;
    this._buffer        = Buffer.alloc(0);
    this.running        = false;
    this._reconnectDelay = 1000;
    this._reconnectTimer = null;
  }

  start() {
    this.running = true;
    this._spawn();
  }

  stop() {
    this.running = false;
    clearTimeout(this._reconnectTimer);
    if (this._process) {
      this._process.kill('SIGTERM');
      this._process = null;
    }
  }

  _spawn() {
    if (!this.running) return;

    const { device, width, height, fps } = config.camera;

    const args = [
      '-f',          'dshow',
      '-vcodec',     'mjpeg',           // tell dshow to use camera's native MJPEG stream
      '-video_size', `${width}x${height}`,
      '-framerate',  String(fps),
      '-i',          `video=${device}`,
      '-f',          'image2pipe',
      '-vcodec',     'copy',            // pass MJPEG frames through without re-encoding
      'pipe:1',
    ];

    console.log(`[Camera] Starting capture: device="${device}" ${width}x${height} @ ${fps}fps (native MJPEG, no re-encode)`);
    this._process = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] });

    this._process.stdout.on('data', (chunk) => this._parseChunk(chunk));

    this._process.stderr.on('data', (data) => {
      const msg = data.toString();
      // ffmpeg writes informational output to stderr — only log actual errors
      if (/error|failed|invalid|could not/i.test(msg)) {
        console.error('[Camera] ffmpeg:', msg.trim().slice(0, 200));
      }
    });

    this._process.on('close', (code) => {
      this._buffer = Buffer.alloc(0);
      if (!this.running) return;

      console.warn(`[Camera] ffmpeg exited (code ${code}). Reconnecting in ${this._reconnectDelay}ms…`);
      this.emit('disconnected');

      this._reconnectTimer = setTimeout(() => {
        this._reconnectDelay = Math.min(this._reconnectDelay * 2, MAX_RECONNECT_DELAY_MS);
        this._spawn();
      }, this._reconnectDelay);
    });

    this._process.on('error', (err) => {
      console.error('[Camera] Failed to start ffmpeg:', err.message);
      console.error('[Camera] Ensure ffmpeg is installed and available in your PATH.');
    });
  }

  _parseChunk(chunk) {
    this._buffer = Buffer.concat([this._buffer, chunk]);

    // Extract all complete JPEG frames from the buffer
    while (true) {
      const soiIndex = this._buffer.indexOf(JPEG_SOI);
      if (soiIndex === -1) {
        this._buffer = Buffer.alloc(0);
        break;
      }

      // Discard bytes that appear before the SOI marker
      if (soiIndex > 0) {
        this._buffer = this._buffer.subarray(soiIndex);
      }

      // Search for EOI after the SOI (skip the 2-byte SOI itself)
      const eoiIndex = this._buffer.indexOf(JPEG_EOI, 2);
      if (eoiIndex === -1) break; // incomplete frame — wait for more data

      const frameEnd = eoiIndex + JPEG_EOI.length;
      const frame    = this._buffer.subarray(0, frameEnd);
      this._buffer   = this._buffer.subarray(frameEnd);

      // Successful parse resets reconnect backoff
      this._reconnectDelay = 1000;
      this.emit('frame', Buffer.from(frame)); // copy so buffer can be sliced freely
    }
  }
}

module.exports = CameraCapture;
