'use strict';

const { Worker } = require('worker_threads');
const path = require('path');

let worker = null;
let readyPromise = null;
let isReady = false;
let idCounter = 0;
const pending = new Map();

function load() {
  if (isReady) return Promise.resolve();
  if (readyPromise) return readyPromise;

  readyPromise = new Promise((resolve, reject) => {
    worker = new Worker(path.join(__dirname, 'motionWorker.js'));

    worker.on('message', (msg) => {
      if (msg.type === 'ready') {
        isReady = true;
        console.log('[MotionDetector] Worker ready.');
        resolve();
        return;
      }

      if (msg.type === 'result') {
        const resolver = pending.get(msg.id);
        if (resolver) {
          pending.delete(msg.id);
          resolver(msg.result);
        }
      }
    });

    worker.on('error', (err) => {
      console.error('[MotionDetector] Worker error:', err.message);
      if (!isReady) reject(err);
    });

    worker.on('exit', (code) => {
      if (code !== 0) console.error(`[MotionDetector] Worker exited with code ${code}`);
      isReady = false;
      readyPromise = null;
      worker = null;
      for (const resolvePending of pending.values()) {
        resolvePending({ motion: false, score: 0, changedPixels: 0, totalPixels: 0 });
      }
      pending.clear();
    });
  });

  return readyPromise;
}

async function detect(jpegBuffer, options = {}) {
  if (!worker) {
    try {
      await load();
    } catch {
      return { motion: false, score: 0, changedPixels: 0, totalPixels: 0 };
    }
  }

  return new Promise((resolve) => {
    const id = ++idCounter;
    pending.set(id, resolve);
    worker.postMessage({ id, buffer: jpegBuffer, options });
  });
}

module.exports = { load, detect };
