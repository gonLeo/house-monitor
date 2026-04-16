'use strict';

// Detection: run inference once every N frames.
// At 30fps, DETECTION_SKIP=15 = ~2 attempts/sec. Gated by _isDetecting so
// inference pile-up is impossible regardless of fps.
const DETECTION_SKIP = 15;

// Frame save: pipe to encoder once every N frames.
// At 30fps, FRAME_SAVE_SKIP=2 gives 15fps to the H.264 encoder — must match SEGMENT_FPS in .env.
const FRAME_SAVE_SKIP = 2;

const MIN_CONFIDENCE = 0.5;

const alarm = require('../alarm');

let _frameCounter = 0;
let _isDetecting  = false;

/**
 * Wire camera frames into the full processing pipeline:
 *   capture → stream → encode frame → detect → save snapshot → notify
 *
 * @param {{
 *   camera:          import('../capture/camera'),
 *   wsServer:        import('../streaming/wsServer'),
 *   detector:        import('../detection/detector'),
 *   presenceTracker: import('../detection/presenceTracker'),
 *   videoRecorder:   import('../capture/videoRecorder'),
 *   db:              import('../db/queries'),
 *   storage:         import('../storage/files'),
 * }} opts
 */
function start({ camera, wsServer, detector, presenceTracker, videoRecorder, db, storage }) {

  camera.on('frame', async (buffer) => {
    _frameCounter++;

    // 1. Broadcast to all live-view clients
    wsServer.broadcastFrame(buffer.toString('base64'));

    // 2. Pipe frame into video encoder (throttled to FRAME_SAVE_SKIP)
    if (_frameCounter % FRAME_SAVE_SKIP === 0) {
      videoRecorder.writeFrame(buffer);
    }

    // 3. Run detection (skip frames while a detection is already running)
    if (_frameCounter % DETECTION_SKIP !== 0 || _isDetecting) return;

    _isDetecting = true;
    try {
      const predictions = await detector.detect(buffer);
      const person = predictions.find(
        (p) => p.class === 'person' && p.score >= MIN_CONFIDENCE
      );

      if (person) {
        const result = presenceTracker.personDetected(person.score);

        if (result.action === 'new_event') {
          // New presence window — create event, snapshot, alarm, UI notification
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

          wsServer.broadcast({
            type: 'detection',
            event: {
              id:         event.id,
              timestamp:  event.timestamp,
              type:       event.type,
              confidence: parseFloat(person.score.toFixed(4)),
            },
          });

        } else if (result.action === 'extend') {
          // Ongoing presence — update ended_at in the DB (debounced to every 2s)
          db.updateEventEndedAt(result.eventId, new Date()).catch((err) => {
            console.warn('[Pipeline] Failed to update ended_at:', err.message);
          });
        }

      } else {
        // No person in this frame — advance the absence timer.
        // When the threshold is reached, personAbsent() returns closing info so we
        // can write the final ended_at (= last moment person was actually seen).
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
