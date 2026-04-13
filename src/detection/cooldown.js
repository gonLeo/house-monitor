'use strict';

/**
 * Anti-spam timer: ensures detections are not reported more often than
 * the configured cooldown period.
 */
class CooldownTimer {
  constructor(cooldownMs) {
    this.cooldownMs = cooldownMs;
    this.lastFired = 0;
  }

  canFire() {
    return Date.now() - this.lastFired > this.cooldownMs;
  }

  reset() {
    this.lastFired = Date.now();
  }
}

module.exports = CooldownTimer;
