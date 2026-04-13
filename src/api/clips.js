'use strict';

const fs     = require('fs');
const path   = require('path');
const os     = require('os');
const { spawn } = require('child_process');
const storage  = require('../storage/files');

/**
 * Generate an MP4 clip from saved frames within a time range and pipe it to res.
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

  // Write an ffmpeg concat list to a temp file
  // Use forward slashes for ffmpeg compatibility on all platforms
  const listContent = frames
    .map((f) => `file '${f.replace(/\\/g, '/')}'`)
    .join('\n');

  const tmpFile = path.join(os.tmpdir(), `hm-clip-${Date.now()}.txt`);
  fs.writeFileSync(tmpFile, listContent, 'utf8');

  const cleanupTmp = () => { try { fs.unlinkSync(tmpFile); } catch { /* ignore */ } };

  res.setHeader('Content-Type', 'video/mp4');
  res.setHeader(
    'Content-Disposition',
    `attachment; filename="clip-${Date.now()}.mp4"`
  );

  const proc = spawn('ffmpeg', [
    '-r',         String(fps),
    '-f',         'concat',
    '-safe',      '0',
    '-i',         tmpFile,
    '-c:v',       'libx264',
    '-pix_fmt',   'yuv420p',
    '-movflags',  'frag_keyframe+empty_moov', // allows streaming without seeking
    '-f',         'mp4',
    'pipe:1',
  ], { stdio: ['ignore', 'pipe', 'pipe'] });

  proc.stdout.pipe(res);
  proc.stderr.on('data', () => {}); // suppress verbose ffmpeg logs

  proc.on('close', cleanupTmp);
  proc.on('error', (err) => {
    console.error('[Clips] ffmpeg spawn error:', err.message);
    cleanupTmp();
    if (!res.headersSent) {
      res.status(500).json({ error: 'ffmpeg not found or failed. Is ffmpeg in your PATH?' });
    }
  });

  // If the client disconnects, kill ffmpeg
  res.on('close', () => proc.kill());
}

module.exports = { generate };
