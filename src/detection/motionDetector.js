'use strict';

const { Worker } = require('worker_threads');
const path = require('path');

const EMPTY_RESULT = Object.freeze({
  motion: false,
  score: 0,
  changedPixels: 0,
  totalPixels: 0,
  requiredPixels: 0,
});
const MAX_REQUESTS_PER_WORKER = 2500;

let worker = null;
let readyPromise = null;
let isReady = false;
let idCounter = 0;
let requestCount = 0;
const pending = new Map();

function resetWorkerState() {
  isReady = false;
  readyPromise = null;
  worker = null;
  requestCount = 0;

  for (const resolvePending of pending.values()) {
    resolvePending(EMPTY_RESULT);
  }
  pending.clear();
}

function recycleWorker(reason = 'scheduled') {
  if (!worker) return;

  const currentWorker = worker;
  console.log(`[MotionDetector] Recycling worker (${reason}).`);
  resetWorkerState();
  currentWorker.terminate().catch(() => {});
}

function load() {
  if (isReady) return Promise.resolve();
  if (readyPromise) return readyPromise;

  readyPromise = new Promise((resolve, reject) => {
    const thisWorker = new Worker(path.join(__dirname, 'motionWorker.js'), {
      // Cap the worker heap so it crashes cleanly (triggering recycle) instead
      // of exhausting system memory and taking down the main process with it.
      resourceLimits: {
        maxOldGenerationSizeMb: 96,
        maxYoungGenerationSizeMb: 32,
      },
    });
    worker = thisWorker;

    thisWorker.on('message', (msg) => {
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
          requestCount++;
          resolver(msg.result);

          if (requestCount >= MAX_REQUESTS_PER_WORKER && pending.size === 0) {
            recycleWorker('memory hygiene');
          }
        }
      }
    });

    thisWorker.on('error', (err) => {
      console.error('[MotionDetector] Worker error:', err.message);
      if (!isReady) reject(err);
    });

    thisWorker.on('exit', (code) => {
      if (code !== 0) console.error(`[MotionDetector] Worker exited with code ${code}`);
      // Guard: only reset if this worker is still the active one.
      // A recycled worker exits *after* a new worker may already be assigned,
      // so without this check resetWorkerState() would null out the new worker.
      if (worker === thisWorker) {
        resetWorkerState();
      }
    });
  });

  return readyPromise;
}

async function detect(jpegBuffer, options = {}) {
  if (!worker) {
    try {
      await load();
    } catch {
      return EMPTY_RESULT;
    }
    // Re-check after await: the old worker's exit event may have fired during
    // the yield and called resetWorkerState(), nulling the newly created worker.
    if (!worker) return EMPTY_RESULT;
  }

  return new Promise((resolve) => {
    const id = ++idCounter;
    pending.set(id, resolve);

    try {
      const payload = Uint8Array.from(jpegBuffer);
      worker.postMessage({ id, buffer: payload, options }, [payload.buffer]);
    } catch (err) {
      pending.delete(id);
      console.error('[MotionDetector] Failed to send frame to worker:', err.message);

      if (/clone|memory/i.test(err.message)) {
        recycleWorker('postMessage failure');
      }

      resolve(EMPTY_RESULT);
    }
  });
}

module.exports = { load, detect };
