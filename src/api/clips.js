'use strict';

const fs     = require('fs');
const path   = require('path');
const os     = require('os');
const { spawn } = require('child_process');
const storage  = require('../storage/files');

/**
 * Generate an MP4 clip from stored video segments (+ audio if available) within
 * a time range and stream it to res.
 *
 * Video segments are H.264 .mp4 files recorded continuously by VideoSegmentRecorder.
 * The concat demuxer trims start/end segments to the requested window using
 * inpoint/outpoint, so no video re-encode is needed — just a fast remux.
 *
 * @param {string|Date} startTime
 * @param {string|Date} endTime
 * @param {import('express').Response} res
 */
async function generate(startTime, endTime, res) {
  const clipStart = new Date(startTime);
  const clipEnd   = new Date(endTime);

  const videoSegments = storage.getVideoSegmentsInRange(startTime, endTime);

  if (videoSegments.length === 0) {
    res.status(404).json({ error: 'No video segments found in the specified time range.' });
    return;
  }

  // Build video concat list with inpoint/outpoint to trim the first and last segments.
  const videoLines = [];
  for (const seg of videoSegments) {
    const absPath  = path.resolve(seg.filePath).replace(/\\/g, '/');
    const inpoint  = Math.max(0, (clipStart.getTime() - seg.segStart.getTime()) / 1000);
    const outpoint = Math.min(
      (seg.segEnd.getTime() - seg.segStart.getTime()) / 1000,
      (clipEnd.getTime()   - seg.segStart.getTime()) / 1000,
    );
    videoLines.push(`file '${absPath}'`);
    if (inpoint  > 0.01)  videoLines.push(`inpoint ${inpoint.toFixed(3)}`);
    if (outpoint > 0.001) videoLines.push(`outpoint ${outpoint.toFixed(3)}`);
  }

  // Build audio concat list (same strategy as before).
  const audioSegments = storage.getAudioSegmentsInRange(startTime, endTime);
  const hasAudio      = audioSegments.length > 0;
  const audioLines    = [];
  if (hasAudio) {
    for (const seg of audioSegments) {
      const absPath  = path.resolve(seg.filePath).replace(/\\/g, '/');
      const inpoint  = Math.max(0, (clipStart.getTime() - seg.segStart.getTime()) / 1000);
      const outpoint = (clipEnd.getTime() - seg.segStart.getTime()) / 1000;
      audioLines.push(`file '${absPath}'`);
      if (inpoint  > 0.01) audioLines.push(`inpoint ${inpoint.toFixed(3)}`);
      audioLines.push(`outpoint ${outpoint.toFixed(3)}`);
    }
  }

  const ts           = Date.now();
  const tmpVideoList = path.join(os.tmpdir(), `hm-vlist-${ts}.txt`);
  const tmpAudioList = hasAudio ? path.join(os.tmpdir(), `hm-alist-${ts}.txt`) : null;
  const tmpOut       = path.join(os.tmpdir(), `hm-clip-${ts}.mp4`);

  fs.writeFileSync(tmpVideoList, videoLines.join('\n'), 'utf8');
  if (hasAudio) fs.writeFileSync(tmpAudioList, audioLines.join('\n'), 'utf8');

  const cleanup = () => {
    try { fs.unlinkSync(tmpVideoList); } catch { /* ignore */ }
    if (tmpAudioList) try { fs.unlinkSync(tmpAudioList); } catch { /* ignore */ }
    try { fs.unlinkSync(tmpOut);      } catch { /* ignore */ }
  };

  let aborted = false;

  // Video: stream copy (no re-encode) — segments are already H.264.
  // Audio: re-encode to AAC for compatibility (m4a → mp4 container).
  const args = [
    '-f', 'concat', '-safe', '0', '-i', tmpVideoList,
  ];
  if (hasAudio) {
    args.push('-f', 'concat', '-safe', '0', '-i', tmpAudioList);
  }
  args.push('-c:v', 'copy');
  if (hasAudio) {
    args.push('-c:a', 'aac', '-b:a', '64k');
  } else {
    args.push('-an');
  }
  args.push('-movflags', '+faststart', '-y', tmpOut);

  const proc = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] });

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
