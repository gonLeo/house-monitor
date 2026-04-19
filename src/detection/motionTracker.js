'use strict';

class MotionTracker {
  constructor({ cooldownMs, clipWindowMs, minConsecutiveDetections }) {
    this._cooldownMs = cooldownMs;
    this._clipWindowMs = clipWindowMs;
    this._minConsecutiveDetections = minConsecutiveDetections;
    this._currentEventId = null;
    this._windowEndsMs = 0;
    this._lastEventClosedMs = 0;
    this._lastDbUpdateMs = 0;
    this._consecutiveHits = 0;
  }

  configure({ cooldownMs, clipWindowMs, minConsecutiveDetections }) {
    this._cooldownMs = cooldownMs;
    this._clipWindowMs = clipWindowMs;
    this._minConsecutiveDetections = minConsecutiveDetections;
  }

  motionDetected(confidence) {
    const now = Date.now();
    this._consecutiveHits++;

    if (this._consecutiveHits < this._minConsecutiveDetections) {
      return { action: 'none' };
    }

    const nextEndedAt = new Date(now + this._clipWindowMs);

    if (!this._currentEventId) {
      if (now - this._lastEventClosedMs < this._cooldownMs) {
        return { action: 'none' };
      }

      this._windowEndsMs = nextEndedAt.getTime();
      this._lastDbUpdateMs = now;
      return { action: 'new_event', confidence, endedAt: nextEndedAt };
    }

    if (nextEndedAt.getTime() > this._windowEndsMs) {
      this._windowEndsMs = nextEndedAt.getTime();
    }

    if (now - this._lastDbUpdateMs >= 2000) {
      this._lastDbUpdateMs = now;
      return { action: 'extend', eventId: this._currentEventId, endedAt: new Date(this._windowEndsMs) };
    }

    return { action: 'active', eventId: this._currentEventId, endedAt: new Date(this._windowEndsMs) };
  }

  motionAbsent() {
    this._consecutiveHits = 0;
    if (!this._currentEventId) return null;

    if (Date.now() > this._windowEndsMs) {
      const eventId = this._currentEventId;
      const endedAt = new Date(this._windowEndsMs);
      this._currentEventId = null;
      this._windowEndsMs = 0;
      this._lastEventClosedMs = Date.now();
      return { action: 'end', eventId, endedAt };
    }

    return null;
  }

  activate(eventId) {
    this._currentEventId = eventId;
  }
}

module.exports = MotionTracker;
