'use strict';

const { parentPort } = require('worker_threads');
// jpeg-js is a lightweight synchronous JPEG decoder (transitive dep of jimp).
// It decodes only JPEG, loads no extra codecs, and keeps pixel data in a
// Buffer (external/native memory) rather than V8 heap — far cheaper than Jimp.
const jpegjs = require('jpeg-js');

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

function createGrayscaleSample(data, sourceWidth, sourceHeight, sampleWidth) {
  const width = Math.max(1, sampleWidth);
  const height = Math.max(1, Math.round((sourceHeight * width) / sourceWidth));
  const gray = new Uint8Array(width * height);

  const xScale = sourceWidth / width;
  const yScale = sourceHeight / height;

  let offset = 0;
  for (let y = 0; y < height; y++) {
    const sourceY = Math.min(sourceHeight - 1, Math.floor((y + 0.5) * yScale));
    const rowOffset = sourceY * sourceWidth * 4;

    for (let x = 0; x < width; x++) {
      const sourceX = Math.min(sourceWidth - 1, Math.floor((x + 0.5) * xScale));
      const idx = rowOffset + (sourceX * 4);
      const r = data[idx];
      const g = data[idx + 1];
      const b = data[idx + 2];
      gray[offset++] = (r * 77 + g * 150 + b * 29) >> 8;
    }
  }

  return { width, height, gray };
}

function analyze(buffer, options = {}) {
  const sampleWidth = Math.round(clamp(Number(options.sampleWidth) || 160, 64, 320));
  const pixelDiffThreshold = clamp(Number(options.pixelDiffThreshold) || 28, 5, 80);
  const minChangedPixels = Math.round(clamp(Number(options.minChangedPixels) || 120, 10, 5000));
  const minChangedRatio = clamp(Number(options.minChangedRatio) || 0.015, 0.001, 0.5);
  const roi = options.roi || { x: 0, y: 0, w: 1, h: 1 };

  // Synchronous decode: pixel data lives in a Buffer (external/native memory),
  // so it does not pressure the V8 heap at all.
  const { data, width: sourceWidth, height: sourceHeight } = jpegjs.decode(buffer, { maxMemoryUsageInMB: 512 });
  const { width, height, gray } = createGrayscaleSample(data, sourceWidth, sourceHeight, sampleWidth);

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

parentPort.on('message', ({ id, buffer, options }) => {
  try {
    const jpegBuffer = toBuffer(buffer);
    const result = analyze(jpegBuffer, options);
    parentPort.postMessage({ type: 'result', id, result });
  } catch (err) {
    console.warn('[MotionWorker] Failed to analyze frame:', err.message);
    parentPort.postMessage({ type: 'result', id, result: EMPTY_RESULT });
  }
});

parentPort.postMessage({ type: 'ready' });
