'use strict';

/**
 * Tracks continuous human presence to produce one DB event per presence window,
 * replacing the fixed-interval cooldown timer.
 *
 * State machine:
 *   INACTIVE ─── personDetected() ──► ACTIVE (returns 'new_event')
 *   ACTIVE   ─── personDetected() ──► ACTIVE (returns 'extend' every 2s, else 'none')
 *   ACTIVE   ─── personAbsent() [>absenceThresholdMs since last seen] ──► INACTIVE
 *
 * Usage in pipeline:
 *   const result = tracker.personDetected(score);
 *   if (result.action === 'new_event') {
 *     const ev = await db.insertEvent({...});
 *     tracker.activate(ev.id);     // ← must call after DB insert
 *     // snapshot, alarm, ws broadcast…
 *   } else if (result.action === 'extend') {
 *     db.updateEventEndedAt(result.eventId, new Date()).catch(…);
 *   }
 *   // On frames where no person is found:
 *   tracker.personAbsent();
 */
class PresenceTracker {
  /**
   * @param {number} absenceThresholdMs  Milliseconds without detection before presence ends.
   */
  constructor(absenceThresholdMs) {
    this._absenceMs      = absenceThresholdMs;
    this._active         = false;
    this._currentEventId = null;
    this._lastSeenMs     = 0;
    this._lastDbUpdateMs = 0;
  }

  /**
   * Notify the tracker that a person was detected in the current frame.
   * @param {number} confidence  Model confidence score (0-1)
   * @returns {{ action: 'new_event'|'extend'|'none', eventId?: string, confidence?: number }}
   */
  personDetected(confidence) {
    const now = Date.now();

    if (!this._active) {
      // Transition INACTIVE → ACTIVE; caller must create a new event.
      this._active         = true;
      this._lastSeenMs     = now;
      this._lastDbUpdateMs = now;
      return { action: 'new_event', confidence };
    }

    // Already active — refresh the "last seen" timestamp.
    this._lastSeenMs = now;

    // Debounce DB writes to at most once every 2 seconds.
    if (now - this._lastDbUpdateMs >= 2000) {
      this._lastDbUpdateMs = now;
      return { action: 'extend', eventId: this._currentEventId };
    }

    return { action: 'none' };
  }

  /**
   * Store the DB event id after insertion so it can be referenced in 'extend' results.
   * Must be called immediately after handling a 'new_event' result.
   * @param {string} eventId
   */
  activate(eventId) {
    this._currentEventId = eventId;
  }

  /**
   * Notify the tracker that no person was found in the current frame.
   * If the absence threshold has elapsed, the presence window is closed.
   * @returns {{ action: 'end', eventId: string, endedAt: Date } | null}
   */
  personAbsent() {
    if (!this._active) return null;
    if (Date.now() - this._lastSeenMs >= this._absenceMs) {
      const endedAt = new Date(this._lastSeenMs); // last moment person was actually seen
      const eventId = this._currentEventId;
      console.log(`[Presence] Presence ended for event ${eventId}.`);
      this._active         = false;
      this._currentEventId = null;
      return { action: 'end', eventId, endedAt };
    }
    return null;
  }
}

module.exports = PresenceTracker;
