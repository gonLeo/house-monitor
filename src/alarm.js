'use strict';

/**
 * Server-side alarm: plays alarm.mp3 directly via ffplay (ships with ffmpeg).
 * This removes the browser round-trip (WS → browser → Audio fetch → play),
 * so the sound fires as soon as the detection result comes back from the worker.
 */

const { spawn } = require('child_process');
const path      = require('path');

const ALARM_PATH = path.join(__dirname, 'public', 'alarm.mp3');
const REPEATS    = 1;

let _enabled = true;
let _activeProc = null;

function setEnabled(val) {
  _enabled = Boolean(val);
  console.log(`[Alarm] ${_enabled ? 'Enabled' : 'Disabled'}`);
}

function isEnabled() {
  return _enabled;
}

function _playOnce(remaining) {
  if (!_enabled || remaining <= 0) {
    _activeProc = null;
    return;
  }

  const proc = spawn(
    'ffplay',
    ['-nodisp', '-autoexit', '-loglevel', 'quiet', ALARM_PATH],
    { stdio: 'ignore', windowsHide: true }
  );

  _activeProc = proc;
  proc.on('close', () => _playOnce(remaining - 1));
  proc.on('error', (err) => {
    console.warn('[Alarm] ffplay error:', err.message);
    _activeProc = null;
  });
}

function play() {
  // Skip if already playing — prevents accumulating concurrent ffplay processes
  // when detection events fire faster than the alarm duration.
  if (!_enabled || _activeProc) return;
  _playOnce(REPEATS);
}

module.exports = { setEnabled, isEnabled, play };
