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

  const listContent = frames
    .map((f) => `file '${path.resolve(f).replace(/\\/g, '/')}'`)
    .join('\n');

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
    '-r',       String(fps),
    '-f',       'concat',
    '-safe',    '0',
    '-i',       tmpList,
    '-c:v',     'libx264',
    '-pix_fmt', 'yuv420p',
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
