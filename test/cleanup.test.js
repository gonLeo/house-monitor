'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');

const cleanup = require('../src/storage/cleanup');
const config = require('../src/config');
const db = require('../src/db/queries');
const VideoSegmentRecorder = require('../src/capture/videoRecorder');

function makeTempTree() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'house-monitor-cleanup-'));
  const segmentsDir = path.join(root, 'segments');
  const audioDir = path.join(root, 'audio');
  const snapshotsDir = path.join(root, 'snapshots');
  const logsDir = path.join(root, 'logs');

  fs.mkdirSync(path.join(segmentsDir, '2026-04-19'), { recursive: true });
  fs.mkdirSync(path.join(audioDir, '2026-04-19'), { recursive: true });
  fs.mkdirSync(snapshotsDir, { recursive: true });
  fs.mkdirSync(logsDir, { recursive: true });

  fs.writeFileSync(path.join(segmentsDir, '2026-04-19', 'clip.mp4'), 'video');
  fs.writeFileSync(path.join(audioDir, '2026-04-19', 'clip.m4a'), 'audio');
  fs.writeFileSync(path.join(snapshotsDir, 'snap.jpg'), 'snap');
  fs.writeFileSync(path.join(logsDir, 'app.log'), 'log line');

  return { root, segmentsDir, audioDir, snapshotsDir, logsDir };
}

test('cleanup pauses active capture and resumes it after deletion', async (t) => {
  const original = {
    segmentsDir: config.segmentsDir,
    audioDir: config.audioDir,
    snapshotsDir: config.snapshotsDir,
    logsDir: config.logsDir,
    deleteAllEvents: db.deleteAllEvents,
    deleteAllConnectivityLogs: db.deleteAllConnectivityLogs,
  };

  const temp = makeTempTree();
  Object.assign(config, {
    segmentsDir: temp.segmentsDir,
    audioDir: temp.audioDir,
    snapshotsDir: temp.snapshotsDir,
    logsDir: temp.logsDir,
  });

  const calls = [];
  const videoRecorder = {
    running: true,
    async stop() { calls.push('video-stop'); this.running = false; },
    start() { calls.push('video-start'); this.running = true; },
  };
  const audioRecorder = {
    running: true,
    async stop() { calls.push('audio-stop'); this.running = false; },
    start() { calls.push('audio-start'); this.running = true; },
  };

  db.deleteAllEvents = async () => { calls.push('db-deleteEvents'); return 5; };
  db.deleteAllConnectivityLogs = async () => { calls.push('db-deleteConnLogs'); return 3; };

  cleanup.setCaptureControllers({ videoRecorder, audioRecorder });

  t.after(() => {
    Object.assign(config, {
      segmentsDir: original.segmentsDir,
      audioDir: original.audioDir,
      snapshotsDir: original.snapshotsDir,
      logsDir: original.logsDir,
    });
    db.deleteAllEvents = original.deleteAllEvents;
    db.deleteAllConnectivityLogs = original.deleteAllConnectivityLogs;
    cleanup.setCaptureControllers({ videoRecorder: null, audioRecorder: null });
    fs.rmSync(temp.root, { recursive: true, force: true });
  });

  const result = await cleanup.runCleanupNow();

  assert.equal(result.filesCount, 3);
  assert.deepEqual(calls, ['video-stop', 'audio-stop', 'db-deleteEvents', 'db-deleteConnLogs', 'video-start', 'audio-start']);
  assert.equal(fs.existsSync(path.join(temp.segmentsDir, '2026-04-19', 'clip.mp4')), false);
  assert.equal(fs.existsSync(path.join(temp.audioDir, '2026-04-19', 'clip.m4a')), false);
  assert.equal(fs.existsSync(path.join(temp.snapshotsDir, 'snap.jpg')), false);
});

test('video recorder stop ignores EOF from a closing ffmpeg pipe', async () => {
  const recorder = new VideoSegmentRecorder();
  const fakeStdin = new EventEmitter();
  fakeStdin.destroyed = false;
  fakeStdin.end = () => {
    process.nextTick(() => {
      const err = new Error('write EOF');
      err.code = 'EOF';
      fakeStdin.emit('error', err);
    });
  };

  recorder.running = true;
  recorder._stdin = fakeStdin;
  recorder._process = { exitCode: 0, killed: false };

  await recorder.stop();
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(recorder.running, false);
});
