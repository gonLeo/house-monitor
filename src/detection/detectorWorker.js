'use strict';

// This script runs in a dedicated Worker Thread, keeping TF.js CPU inference
// completely off the main event loop so frame streaming stays fluid.

const { parentPort } = require('worker_threads');
const tf      = require('@tensorflow/tfjs-node'); // native C++ backend — ~10x faster than pure-JS
const cocoSsd = require('@tensorflow-models/coco-ssd');

let model = null;

function toBuffer(value) {
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array) {
    return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  }
  if (value instanceof ArrayBuffer) return Buffer.from(value);
  return Buffer.from(value || []);
}

async function init() {
  // tfjs-node registers its own backend automatically — no setBackend needed.
  await tf.ready();
  model = await cocoSsd.load({ base: 'lite_mobilenet_v2' });

  // Warm-up: run one inference on a blank tensor so TF.js JIT-compiles
  // all operations now rather than on the first real frame.
  const dummy = tf.zeros([300, 300, 3], 'int32');
  await model.detect(dummy);
  dummy.dispose();

  parentPort.postMessage({ type: 'ready' });
}

parentPort.on('message', async ({ id, buffer }) => {
  if (!model) {
    parentPort.postMessage({ type: 'result', id, predictions: [] });
    return;
  }

  let predictions = [];
  let inputTensor = null;

  try {
    const jpegBuffer = toBuffer(buffer);
    inputTensor = tf.tidy(() => {
      const decoded = tf.node.decodeImage(jpegBuffer, 3);
      const [height, width] = decoded.shape;
      const targetWidth = 300;
      const targetHeight = Math.max(1, Math.round((height * targetWidth) / width));

      return tf.image
        .resizeBilinear(decoded, [targetHeight, targetWidth], true)
        .cast('int32');
    });

    predictions = await model.detect(inputTensor);
  } catch {
    // ignore bad frames
  } finally {
    if (inputTensor) inputTensor.dispose();
  }

  parentPort.postMessage({ type: 'result', id, predictions });
});

init().catch((err) => {
  console.error('[DetectorWorker] Fatal init error:', err.message);
  process.exit(1);
});
