'use strict';

// Detection now runs in a dedicated Worker Thread so TF.js CPU inference
// never blocks the main event loop (which handles frame streaming).

const { Worker } = require('worker_threads');
const path = require('path');

let worker    = null;
let isReady   = false;
let idCounter = 0;
let loadPromise = null;
const pending = new Map(); // id → resolve function

function load() {
  if (isReady) return Promise.resolve();
  if (loadPromise) return loadPromise;

  loadPromise = new Promise((resolve, reject) => {
    worker = new Worker(path.join(__dirname, 'detectorWorker.js'));

    worker.on('message', (msg) => {
      if (msg.type === 'ready') {
        isReady = true;
        console.log('[Detector] COCO-SSD model loaded (worker thread).');
        resolve();
      } else if (msg.type === 'result') {
        const resolver = pending.get(msg.id);
        if (resolver) {
          pending.delete(msg.id);
          resolver(msg.predictions);
        }
      }
    });

    worker.on('error', (err) => {
      console.error('[Detector] Worker error:', err.message);
      if (!isReady) reject(err);
    });

    worker.on('exit', (code) => {
      if (code !== 0) console.error(`[Detector] Worker exited with code ${code}`);
      isReady = false;
      loadPromise = null;
      worker = null;
      for (const resolvePending of pending.values()) {
        resolvePending([]);
      }
      pending.clear();
    });
  });

  return loadPromise;
}

function isLoaded() {
  return isReady;
}

/**
 * Send a JPEG buffer to the worker thread for inference.
 * The main thread is NOT blocked while inference runs.
 * @param {Buffer} jpegBuffer
 * @returns {Promise<Array>}
 */
function detect(jpegBuffer) {
  if (!isReady || !worker) return Promise.resolve([]);

  return new Promise((resolve) => {
    const id = ++idCounter;
    pending.set(id, resolve);
    // postMessage with structured clone — buffer is copied so the original
    // remains usable in the main thread (e.g. for saveSnapshot)
    worker.postMessage({ id, buffer: jpegBuffer });
  });
}

module.exports = { load, detect, isLoaded };
