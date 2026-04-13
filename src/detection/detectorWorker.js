'use strict';

// This script runs in a dedicated Worker Thread, keeping TF.js CPU inference
// completely off the main event loop so frame streaming stays fluid.

const { parentPort } = require('worker_threads');
const tf      = require('@tensorflow/tfjs');
const cocoSsd = require('@tensorflow-models/coco-ssd');
const Jimp    = require('jimp');

let model = null;

async function init() {
  await tf.setBackend('cpu');
  await tf.ready();
  model = await cocoSsd.load({ base: 'lite_mobilenet_v2' });
  parentPort.postMessage({ type: 'ready' });
}

parentPort.on('message', async ({ id, buffer }) => {
  if (!model) {
    parentPort.postMessage({ type: 'result', id, predictions: [] });
    return;
  }

  let predictions = [];
  try {
    const image = await Jimp.read(Buffer.from(buffer));
    const { data, width, height } = image.bitmap;

    const rgbData = new Uint8Array(width * height * 3);
    for (let i = 0; i < width * height; i++) {
      rgbData[i * 3]     = data[i * 4];
      rgbData[i * 3 + 1] = data[i * 4 + 1];
      rgbData[i * 3 + 2] = data[i * 4 + 2];
    }

    const tensor = tf.tensor3d(rgbData, [height, width, 3], 'int32');
    predictions = await model.detect(tensor);
    tensor.dispose();
  } catch {
    // ignore bad frames
  }

  parentPort.postMessage({ type: 'result', id, predictions });
});

init().catch((err) => {
  console.error('[DetectorWorker] Fatal init error:', err.message);
  process.exit(1);
});
