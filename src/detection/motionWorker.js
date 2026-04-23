'use strict';

const { parentPort } = require('worker_threads');
// sharp (libvips) replaces jpeg-js for JPEG decode + resize + greyscale.
// It uses a native C streaming pipeline that processes images tile-by-tile,
// so peak memory is a fraction of decoding the full frame first (jpeg-js approach).
// Pixel data is returned as a raw Buffer in external/native memory, same as before.
const sharp = require('sharp');

const EMPTY_RESULT = Object.freeze({
  motion: false,
  score: 0,
  changedPixels: 0,
  totalPixels: 0,
  requiredPixels: 0,
});

let previousGray = null;
let previousWidth = 0;
let previousHeight = 0;

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function toBuffer(value) {
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array) {
    return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  }
  if (value instanceof ArrayBuffer) return Buffer.from(value);
  return Buffer.from(value || []);
}

async function analyze(buffer, options = {}) {
  const sampleWidth = Math.round(clamp(Number(options.sampleWidth) || 160, 64, 320));
  const pixelDiffThreshold = clamp(Number(options.pixelDiffThreshold) || 28, 5, 80);
  const minChangedPixels = Math.round(clamp(Number(options.minChangedPixels) || 120, 10, 5000));
  const minChangedRatio = clamp(Number(options.minChangedRatio) || 0.015, 0.001, 0.5);
  const roi = options.roi || { x: 0, y: 0, w: 1, h: 1 };

  // sharp pipeline: decode JPEG → resize to sampleWidth (aspect-preserving) →
  // convert to single-channel greyscale → raw pixel Buffer.
  // All in a single native C pass; far lower peak memory than jpegjs which fully
  // decodes the MJPEG frame (e.g. 1280×720 = ~3.5 MB RGBA) before any resize.
  const { data, info } = await sharp(buffer)
    .resize(sampleWidth, null, { fit: 'inside', kernel: 'nearest' })
    .greyscale()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const width  = info.width;
  const height = info.height;
  const gray   = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);

  if (!previousGray || previousWidth !== width || previousHeight !== height) {
    previousGray = gray;
    previousWidth = width;
    previousHeight = height;
    return {
      ...EMPTY_RESULT,
      totalPixels: width * height,
      requiredPixels: minChangedPixels,
    };
  }

  const startX = Math.floor(clamp(Number(roi.x) || 0, 0, 1) * width);
  const startY = Math.floor(clamp(Number(roi.y) || 0, 0, 1) * height);
  const endX = Math.ceil(clamp((Number(roi.x) || 0) + (Number(roi.w) || 1), 0.05, 1) * width);
  const endY = Math.ceil(clamp((Number(roi.y) || 0) + (Number(roi.h) || 1), 0.05, 1) * height);

  let changedPixels = 0;
  let totalPixels = 0;

  for (let y = startY; y < endY; y++) {
    const rowOffset = y * width;
    for (let x = startX; x < endX; x++) {
      const idx = rowOffset + x;
      totalPixels++;
      if (Math.abs(gray[idx] - previousGray[idx]) >= pixelDiffThreshold) {
        changedPixels++;
      }
    }
  }

  previousGray = gray;
  previousWidth = width;
  previousHeight = height;

  const requiredPixels = Math.max(minChangedPixels, Math.ceil(totalPixels * minChangedRatio));
  const score = totalPixels > 0 ? changedPixels / totalPixels : 0;

  return {
    motion: changedPixels >= requiredPixels,
    score,
    changedPixels,
    totalPixels,
    requiredPixels,
  };
}

parentPort.on('message', async ({ id, buffer, options }) => {
  try {
    const jpegBuffer = toBuffer(buffer);
    const result = await analyze(jpegBuffer, options);
    parentPort.postMessage({ type: 'result', id, result });
  } catch (err) {
    console.warn('[MotionWorker] Failed to analyze frame:', err.message);
    parentPort.postMessage({ type: 'result', id, result: EMPTY_RESULT });
  }
});

parentPort.postMessage({ type: 'ready' });
