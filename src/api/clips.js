'use strict';

const fs     = require('fs');
const path   = require('path');
const os     = require('os');
const { spawn } = require('child_process');
const storage  = require('../storage/files');

/**
 * Generate an MP4 clip from saved frames within a time range and stream it to res.
 * Encodes to a temp file first — libx264 does not write reliably to pipe:1 on Windows.
 *
 * @param {string|Date} startTime
 * @param {string|Date} endTime
 * @param {number}      fps
 * @param {import('express').Response} res
 */
async function generate(startTime, endTime, fps, res) {
  const frames = await storage.getFramesInRange(startTime, endTime);

  if (frames.length === 0) {
    res.status(404).json({ error: 'No frames found in the specified time range.' });
    return;
  }

  // Parse each frame's actual timestamp from the path (YYYY-MM-DD/HH-MM-SS-mmm.jpg)
  // and compute real inter-frame durations so the video plays at 1x speed.
  function parseFrameMs(framePath) {
    const dateDir  = path.basename(path.dirname(framePath));   // "2026-04-13"
    const fileName = path.basename(framePath, '.jpg');          // "15-04-50-657"
    const [y, mo, d]     = dateDir.split('-').map(Number);
    const [h, mi, s, ms] = fileName.split('-').map(Number);
    return new Date(y, mo - 1, d, h, mi, s, ms).getTime();
  }

  const SPEED   = 1.0; // playback speed multiplier (>1 = faster)
  const OUT_FPS  = 25;   // output framerate — higher = smoother (more frame duplication)
  const defaultDuration = 1 / fps;
  const lines = [];
  for (let i = 0; i < frames.length; i++) {
    const absPath = path.resolve(frames[i]).replace(/\\/g, '/');
    const rawDuration = i < frames.length - 1
      ? (parseFrameMs(frames[i + 1]) - parseFrameMs(frames[i])) / 1000
      : defaultDuration;
    const duration = rawDuration / SPEED;
    lines.push(`file '${absPath}'`);
    lines.push(`duration ${duration.toFixed(6)}`);
  }
  const listContent = lines.join('\n');

  const ts      = Date.now();
  const tmpList = path.join(os.tmpdir(), `hm-list-${ts}.txt`);
  const tmpOut  = path.join(os.tmpdir(), `hm-clip-${ts}.mp4`);

  fs.writeFileSync(tmpList, listContent, 'utf8');

  const cleanup = () => {
    try { fs.unlinkSync(tmpList); } catch { /* ignore */ }
    try { fs.unlinkSync(tmpOut);  } catch { /* ignore */ }
  };

  let aborted = false;

  const proc = spawn('ffmpeg', [
    '-f',       'concat',
    '-safe',    '0',
    '-i',       tmpList,
    '-c:v',     'libx264',
    '-pix_fmt', 'yuv420p',
    '-r',       String(OUT_FPS), // constant output fps — duplicates frames to fill gaps
    '-y',
    tmpOut,
  ], { stdio: ['ignore', 'ignore', 'pipe'] });

  let stderr = '';
  proc.stderr.on('data', (d) => { stderr += d.toString(); });

  res.on('close', () => {
    if (!proc.killed) { aborted = true; proc.kill(); }
    cleanup();
  });

  proc.on('error', (err) => {
    console.error('[Clips] ffmpeg spawn error:', err.message);
    cleanup();
    if (!res.headersSent) res.status(500).json({ error: 'ffmpeg not found. Is ffmpeg in your PATH?' });
  });

  proc.on('close', (code) => {
    if (aborted) return;

    if (code !== 0 || !fs.existsSync(tmpOut)) {
      console.error('[Clips] ffmpeg exited with code', code, '\n', stderr.slice(-800));
      cleanup();
      if (!res.headersSent) res.status(500).json({ error: 'ffmpeg failed to generate clip.' });
      return;
    }

    const stat = fs.statSync(tmpOut);
    res.setHeader('Content-Type', 'video/mp4');
    res.setHeader('Content-Length', stat.size);
    res.setHeader('Content-Disposition', `attachment; filename="clip-${ts}.mp4"`);

    const stream = fs.createReadStream(tmpOut);
    stream.pipe(res);
    stream.on('close', cleanup);
    stream.on('error', () => cleanup());
  });
}

module.exports = { generate };
