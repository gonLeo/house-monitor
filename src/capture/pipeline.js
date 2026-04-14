'use strict';

// Detection: run inference once every N frames.
// At 30fps, DETECTION_SKIP=15 = ~2 attempts/sec. Gated by _isDetecting so
// inference pile-up is impossible regardless of fps.
const DETECTION_SKIP = 15;

// Frame save: write to disk once every N frames for clip generation.
// At 30fps, FRAME_SAVE_SKIP=3 saves ~10fps — smooth clips, manageable disk I/O.
const FRAME_SAVE_SKIP = 3;

const MIN_CONFIDENCE = 0.5;

const alarm = require('../alarm');

let _frameCounter = 0;
let _isDetecting  = false;

/**
 * Wire camera frames into the full processing pipeline:
 *   capture → stream → save frame → detect → save snapshot → notify
 *
 * @param {{
 *   camera:    import('../capture/camera'),
 *   wsServer:  import('../streaming/wsServer'),
 *   detector:  import('../detection/detector'),
 *   cooldown:  import('../detection/cooldown'),
 *   db:        import('../db/queries'),
 *   storage:   import('../storage/files'),
 * }} opts
 */
function start({ camera, wsServer, detector, cooldown, db, storage }) {

  camera.on('frame', async (buffer) => {
    _frameCounter++;

    // 1. Broadcast to all live-view clients
    wsServer.broadcastFrame(buffer.toString('base64'));

    // 2. Save frame to disk for clip generation (throttled to FRAME_SAVE_SKIP)
    if (_frameCounter % FRAME_SAVE_SKIP === 0) {
      storage.saveFrame(buffer, new Date()).catch((err) => {
        console.warn('[Pipeline] Frame save failed:', err.message);
      });
    }

    // 3. Run detection (skip frames while a detection is already running)
    if (_frameCounter % DETECTION_SKIP !== 0 || _isDetecting) return;

    _isDetecting = true;
    try {
      const predictions = await detector.detect(buffer);
      const person = predictions.find(
        (p) => p.class === 'person' && p.score >= MIN_CONFIDENCE
      );

      if (person && cooldown.canFire()) {
        cooldown.reset();

        // Insert event first to get the generated UUID
        const event = await db.insertEvent({
          type:       'person_detected',
          confidence: parseFloat(person.score.toFixed(4)),
        });

        // Save snapshot and update the event row with its path
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
