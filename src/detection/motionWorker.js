'use strict';

const { parentPort } = require('worker_threads');
const Jimp = require('jimp');

let previousGray = null;
let previousWidth = 0;
let previousHeight = 0;

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

async function analyze(buffer, options = {}) {
  const sampleWidth = Math.round(clamp(Number(options.sampleWidth) || 160, 64, 320));
  const pixelDiffThreshold = clamp(Number(options.pixelDiffThreshold) || 28, 5, 80);
  const minChangedPixels = Math.round(clamp(Number(options.minChangedPixels) || 120, 10, 5000));
  const minChangedRatio = clamp(Number(options.minChangedRatio) || 0.015, 0.001, 0.5);
  const roi = options.roi || { x: 0, y: 0, w: 1, h: 1 };

  const image = await Jimp.read(buffer);
  image.resize(sampleWidth, Jimp.AUTO).greyscale().blur(1);

  const { width, height, data } = image.bitmap;
  const gray = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = y * width + x;
      gray[idx] = data[idx * 4];
    }
  }

  if (!previousGray || previousWidth !== width || previousHeight !== height) {
    previousGray = gray;
    previousWidth = width;
    previousHeight = height;
    return { motion: false, score: 0, changedPixels: 0, totalPixels: 0, requiredPixels: minChangedPixels };
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
    const jpegBuffer = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
    const result = await analyze(jpegBuffer, options);
    parentPort.postMessage({ type: 'result', id, result });
  } catch (err) {
    console.warn('[MotionWorker] Failed to analyze frame:', err.message);
    parentPort.postMessage({
      type: 'result',
      id,
      result: { motion: false, score: 0, changedPixels: 0, totalPixels: 0, requiredPixels: 0 },
    });
  }
});

parentPort.postMessage({ type: 'ready' });
