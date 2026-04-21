'use strict';

const config = require('../config');

// Detection: run inference once every N frames.
// At 30fps, DETECTION_SKIP=10 = ~3 attempts/sec. Gated by _isDetecting so
// inference pile-up is impossible regardless of fps.
const DETECTION_SKIP = Math.max(1, config.detectionFrameSkip || 10);

// Frame save: pipe to encoder once every N frames.
// At 30fps, FRAME_SAVE_SKIP=2 gives 15fps to the H.264 encoder — must match SEGMENT_FPS in .env.
const FRAME_SAVE_SKIP = 2; // 30fps / 2 = 15fps to encoder

const MIN_CONFIDENCE = 0.5;

const alarm = require('../alarm');
const ntfy  = require('../notifications/ntfy');

function usesMotionMode(mode) {
  return mode === 'motion_only' || mode === 'motion_and_human';
}

function usesHumanMode(mode) {
  return mode === 'human_only' || mode === 'motion_and_human';
}

async function notifyNewDetection({ event, confidence, wsServer }) {
  wsServer.broadcast({
    type: 'detection',
    event: {
      id:         event.id,
      timestamp:  event.timestamp,
      ended_at:   event.ended_at || null,
      type:       event.type,
      confidence,
    },
  });
}

async function processMotionDetection({ buffer, motionResult, motionTracker, db, storage, wsServer }) {
  const motionScore = parseFloat((motionResult.score || 0).toFixed(4));
  const result = motionTracker.motionDetected(motionScore);

  if (result.action === 'new_event') {
    const event = await db.insertEvent({
      type: 'motion_detected',
      confidence: motionScore,
    });

    motionTracker.activate(event.id);
    await db.updateEventEndedAt(event.id, result.endedAt);

    const snapshotPath = await storage.saveSnapshot(buffer, event.id);
    await db.updateEventSnapshot(event.id, snapshotPath);

    console.log(
      `[Motion] Motion detected! activity=${(motionScore * 100).toFixed(2)}% id=${event.id}`
    );

    alarm.play();
    ntfy.motionDetected({ activityRatio: motionResult.score || 0 });

    await notifyNewDetection({
      wsServer,
      confidence: motionScore,
      event: {
        ...event,
        snapshot_path: snapshotPath,
        ended_at: result.endedAt,
      },
    });
  } else if (result.action === 'extend' && result.eventId) {
    db.updateEventEndedAt(result.eventId, result.endedAt).catch((err) => {
      console.warn('[Pipeline] Failed to extend motion window:', err.message);
    });
  }

  return Boolean(motionResult.motion);
}

async function processHumanDetection({ buffer, detector, presenceTracker, db, storage, wsServer }) {
  if (!detector.isLoaded()) {
    await detector.load();
  }

  const predictions = await detector.detect(buffer);
  const person = predictions.find(
    (p) => p.class === 'person' && p.score >= MIN_CONFIDENCE
  );

  if (person) {
    const result = presenceTracker.personDetected(person.score);

    if (result.action === 'new_event') {
      const event = await db.insertEvent({
        type:       'person_detected',
        confidence: parseFloat(person.score.toFixed(4)),
      });

      presenceTracker.activate(event.id);

      const snapshotPath = await storage.saveSnapshot(buffer, event.id);
      await db.updateEventSnapshot(event.id, snapshotPath);

      console.log(
        `[Detection] Person detected! confidence=${(person.score * 100).toFixed(1)}% id=${event.id}`
      );

      alarm.play();
      ntfy.personDetected({ confidence: person.score });

      await notifyNewDetection({
        wsServer,
        confidence: parseFloat(person.score.toFixed(4)),
        event: {
          ...event,
          snapshot_path: snapshotPath,
        },
      });
    } else if (result.action === 'extend') {
      db.updateEventEndedAt(result.eventId, new Date()).catch((err) => {
        console.warn('[Pipeline] Failed to update ended_at:', err.message);
      });
    }

    return true;
  }

  const closing = presenceTracker.personAbsent();
  if (closing) {
    db.updateEventEndedAt(closing.eventId, closing.endedAt).catch((err) => {
      console.warn('[Pipeline] Failed to finalize ended_at:', err.message);
    });
  }

  return false;
}

/**
 * Wire camera frames into the full processing pipeline:
 *   capture → stream → encode frame → detect → save snapshot → notify
 */
function start({ camera, wsServer, detector, motionDetector, presenceTracker, motionTracker, videoRecorder, db, storage, settings }) {
  // Local to this start() call so multiple invocations (tests, hot-reload) don't
  // share state or interfere with each other's detection gate.
  let _frameCounter = 0;
  let _isDetecting  = false;

  camera.on('frame', async (buffer) => {
    _frameCounter++;

    // 1. Broadcast to all live-view clients.
    // Keep the frame as a raw JPEG Buffer so we avoid expensive base64 conversion
    // on every camera frame when running on lower-end CPUs.
    wsServer.broadcastFrame(buffer);

    // 2. Pipe frame into video encoder (throttled to FRAME_SAVE_SKIP)
    if (_frameCounter % FRAME_SAVE_SKIP === 0) {
      videoRecorder.writeFrame(buffer);
    }

    // 3. Run detection (skip frames while a detection is already running)
    if (_frameCounter % DETECTION_SKIP !== 0 || _isDetecting) return;

    _isDetecting = true;
    try {
      const liveSettings = settings.peek();
      const mode = liveSettings.detectionMode;

      motionTracker.configure({
        cooldownMs: liveSettings.motion.cooldownSeconds * 1000,
        clipWindowMs: liveSettings.motion.clipSecondsAfter * 1000,
        minConsecutiveDetections: liveSettings.motion.consecutiveDetections,
      });

      let motionTriggered = false;

      if (usesMotionMode(mode)) {
        const motionResult = await motionDetector.detect(buffer, liveSettings.motion);
        if (motionResult.motion) {
          motionTriggered = await processMotionDetection({
            buffer,
            motionResult,
            motionTracker,
            db,
            storage,
            wsServer,
          });
        } else {
          const closing = motionTracker.motionAbsent();
          if (closing) {
            db.updateEventEndedAt(closing.eventId, closing.endedAt).catch((err) => {
              console.warn('[Pipeline] Failed to finalize motion event:', err.message);
            });
          }
        }
      } else {
        const closing = motionTracker.motionAbsent();
        if (closing) {
          db.updateEventEndedAt(closing.eventId, closing.endedAt).catch((err) => {
            console.warn('[Pipeline] Failed to finalize motion event:', err.message);
          });
        }
      }

      const shouldRunHuman = usesHumanMode(mode)
        && (mode === 'human_only' || motionTriggered || presenceTracker.isActive());

      if (shouldRunHuman) {
        await processHumanDetection({
          buffer,
          detector,
          presenceTracker,
          db,
          storage,
          wsServer,
        });
      } else {
        const closing = presenceTracker.personAbsent();
        if (closing) {
          db.updateEventEndedAt(closing.eventId, closing.endedAt).catch((err) => {
            console.warn('[Pipeline] Failed to finalize ended_at:', err.message);
          });
        }
      }
    } catch (err) {
      console.error('[Pipeline] Error during detection:', err.message);
    } finally {
      _isDetecting = false;
    }
  });

  camera.on('disconnected', () => {
    wsServer.broadcast({ type: 'camera_status', status: 'disconnected' });
  });

  console.log('[Pipeline] Started.');
}

module.exports = { start };
