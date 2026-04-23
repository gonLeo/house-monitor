'use strict';

const DEFAULT_SETTINGS = Object.freeze({
  detectionMode: 'motion_only',
  alarmEnabled: true,
  notificationsEnabled: true,
  motion: {
    pixelDiffThreshold: 28,
    minChangedPixels: 120,
    minChangedRatio: 0.015,
    consecutiveDetections: 2,
    cooldownSeconds: 30,
    clipSecondsAfter: 120,
    preRollSeconds: 10,
    sampleWidth: 160,
    roi: { x: 0, y: 0, w: 1, h: 1 },
  },
});

let _settings = clone(DEFAULT_SETTINGS);

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function deepMerge(base, patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
    return patch === undefined ? base : patch;
  }

  const out = Array.isArray(base) ? [...base] : { ...(base || {}) };
  for (const [key, value] of Object.entries(patch)) {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      out[key] = deepMerge(out[key], value);
    } else if (value !== undefined) {
      out[key] = value;
    }
  }
  return out;
}

function clampNumber(value, min, max, fallback) {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.min(max, Math.max(min, num));
}

function normalizeRoi(roi = {}) {
  const x = clampNumber(roi.x, 0, 1, 0);
  const y = clampNumber(roi.y, 0, 1, 0);
  const w = clampNumber(roi.w, 0.05, 1, 1);
  const h = clampNumber(roi.h, 0.05, 1, 1);

  return {
    x,
    y,
    w: Math.min(w, 1 - x),
    h: Math.min(h, 1 - y),
  };
}

function normalize(input = {}) {
  const merged = deepMerge(clone(DEFAULT_SETTINGS), input);

  const detectionMode = ['motion_only', 'motion_and_human', 'human_only'].includes(merged.detectionMode)
    ? merged.detectionMode
    : DEFAULT_SETTINGS.detectionMode;

  return {
    detectionMode,
    alarmEnabled: Boolean(merged.alarmEnabled),
    notificationsEnabled: Boolean(merged.notificationsEnabled),
    motion: {
      pixelDiffThreshold: clampNumber(merged.motion?.pixelDiffThreshold, 5, 80, DEFAULT_SETTINGS.motion.pixelDiffThreshold),
      minChangedPixels: Math.round(clampNumber(merged.motion?.minChangedPixels, 10, 5000, DEFAULT_SETTINGS.motion.minChangedPixels)),
      minChangedRatio: clampNumber(merged.motion?.minChangedRatio, 0.001, 0.5, DEFAULT_SETTINGS.motion.minChangedRatio),
      consecutiveDetections: Math.round(clampNumber(merged.motion?.consecutiveDetections, 1, 10, DEFAULT_SETTINGS.motion.consecutiveDetections)),
      cooldownSeconds: Math.round(clampNumber(merged.motion?.cooldownSeconds, 5, 600, DEFAULT_SETTINGS.motion.cooldownSeconds)),
      clipSecondsAfter: Math.round(clampNumber(merged.motion?.clipSecondsAfter, 15, 600, DEFAULT_SETTINGS.motion.clipSecondsAfter)),
      preRollSeconds: Math.round(clampNumber(merged.motion?.preRollSeconds, 0, 30, DEFAULT_SETTINGS.motion.preRollSeconds)),
      sampleWidth: Math.round(clampNumber(merged.motion?.sampleWidth, 64, 320, DEFAULT_SETTINGS.motion.sampleWidth)),
      roi: normalizeRoi(merged.motion?.roi),
    },
  };
}

async function load(db) {
  const saved = await db.getPreference('system_settings');
  _settings = normalize(saved || {});
  await db.setPreference('system_settings', _settings);
  return get();
}

async function update(db, patch) {
  _settings = normalize(deepMerge(_settings, patch));
  await db.setPreference('system_settings', _settings);
  return get();
}

function get() {
  return clone(_settings);
}

function peek() {
  return _settings;
}

module.exports = {
  DEFAULT_SETTINGS,
  get,
  peek,
  load,
  update,
  normalize,
};
