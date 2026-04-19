'use strict';

require('dotenv').config();

module.exports = {
  db: {
    host:     process.env.DB_HOST     || 'localhost',
    port:     parseInt(process.env.DB_PORT || '5432', 10),
    database: process.env.DB_NAME     || 'housemonitor',
    user:     process.env.DB_USER     || 'monitor',
    password: process.env.DB_PASSWORD || 'monitor123',
  },
  camera: {
    device: process.env.CAMERA_DEVICE || 'Integrated Webcam',
    width:  parseInt(process.env.CAMERA_WIDTH  || '1280', 10),
    height: parseInt(process.env.CAMERA_HEIGHT || '720',  10),
    fps:    parseInt(process.env.CAMERA_FPS    || '30',   10),
  },
  audio: {
    // Set AUDIO_DEVICE to the exact dshow audio device name (empty = disabled).
    // To list available audio devices run:
    //   ffmpeg -list_devices true -f dshow -i dummy 2>&1
    device:         process.env.AUDIO_DEVICE          || '',
    segmentSeconds: parseInt(process.env.AUDIO_SEGMENT_SECONDS || '60', 10),
    bitrate:        process.env.AUDIO_BITRATE          || '64k',
  },
  // Detection attempts are gated by _isDetecting, so lowering this value reduces
  // the time-to-first-detect without allowing inference pile-up on slow CPUs.
  detectionFrameSkip:      parseInt(process.env.DETECTION_FRAME_SKIP       || '10',  10),
  absenceThresholdSeconds: parseInt(process.env.ABSENCE_THRESHOLD_SECONDS   || '10',  10),
  port:                    parseInt(process.env.PORT                       || '3000', 10),
  framesDir:               process.env.FRAMES_DIR                          || './frames',
  snapshotsDir:            process.env.SNAPSHOTS_DIR                       || './snapshots',
  audioDir:                process.env.AUDIO_DIR                           || './audio',
  segmentsDir:             process.env.SEGMENTS_DIR                        || './segments',
  segmentDurationSeconds:  parseInt(process.env.SEGMENT_DURATION_SECONDS   || '60',   10),
  // FPS at which pipeline feeds frames into the video encoder.
  // Must match: Math.round(camera.fps / FRAME_SAVE_SKIP) where FRAME_SAVE_SKIP=2.
  segmentFps:              parseInt(process.env.SEGMENT_FPS                || '15',   10),
  retentionHours:          parseInt(process.env.RETENTION_HOURS            || '12',   10),
  logsDir:                 process.env.LOGS_DIR                            || './logs',
  // ntfy.sh push notifications — set to your topic string, leave empty to disable.
  ntfyTopic:               process.env.NTFY_TOPIC                          || '',
  accessToken:             process.env.TOKENACCESS || process.env.tokenaccess || '',
};
