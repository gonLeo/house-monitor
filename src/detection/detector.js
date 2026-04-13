'use strict';

const tf = require('@tensorflow/tfjs');
const cocoSsd = require('@tensorflow-models/coco-ssd');
const Jimp = require('jimp');

let model = null;

/**
 * Load the COCO-SSD model. Call once at startup.
 * Downloads weights from CDN on first run (~10 MB), then they are cached by TF.js.
 */
async function load() {
  // Force CPU backend — no WebGL in Node.js
  await tf.setBackend('cpu');
  await tf.ready();
  console.log('[Detector] TF.js backend:', tf.getBackend());

  model = await cocoSsd.load({ base: 'lite_mobilenet_v2' });
  console.log('[Detector] COCO-SSD model loaded.');
}

/**
 * Detect objects in a JPEG buffer. Returns raw coco-ssd predictions array.
 * @param {Buffer} jpegBuffer
 * @returns {Promise<Array>}
 */
async function detect(jpegBuffer) {
  if (!model) return [];

  let image;
  try {
    image = await Jimp.read(jpegBuffer);
  } catch (err) {
    console.warn('[Detector] Failed to decode frame:', err.message);
    return [];
  }

  const { data, width, height } = image.bitmap;

  // Convert RGBA Buffer to RGB Uint8Array (TF.js expects RGB)
  const rgbData = new Uint8Array(width * height * 3);
  for (let i = 0; i < width * height; i++) {
    rgbData[i * 3]     = data[i * 4];     // R
    rgbData[i * 3 + 1] = data[i * 4 + 1]; // G
    rgbData[i * 3 + 2] = data[i * 4 + 2]; // B
  }

  // Create tensor and run inference
  const tensor = tf.tensor3d(rgbData, [height, width, 3], 'int32');
  let predictions = [];
  try {
    predictions = await model.detect(tensor);
  } catch (err) {
    console.warn('[Detector] Inference error:', err.message);
  } finally {
    tensor.dispose(); // prevent memory leak
  }

  return predictions;
}

module.exports = { load, detect };
