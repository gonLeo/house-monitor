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
    width:  parseInt(process.env.CAMERA_WIDTH  || '640', 10),
    height: parseInt(process.env.CAMERA_HEIGHT || '480', 10),
    fps:    parseInt(process.env.CAMERA_FPS    || '10',  10),
  },
  cooldownSeconds:      parseInt(process.env.COOLDOWN_SECONDS       || '30', 10),
  port:                 parseInt(process.env.PORT                   || '3000', 10),
  framesDir:            process.env.FRAMES_DIR                      || './frames',
  snapshotsDir:         process.env.SNAPSHOTS_DIR                   || './snapshots',
  frameRetentionHours:  parseInt(process.env.FRAME_RETENTION_HOURS  || '48', 10),
};
