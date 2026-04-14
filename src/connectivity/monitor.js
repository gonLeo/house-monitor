'use strict';

const dns = require('dns');
const { promisify } = require('util');

const dnsResolve = promisify(dns.resolve);
const CHECK_INTERVAL_MS = 1 * 60 * 1000; // 1 minute

class ConnectivityMonitor {
  constructor() {
    this.status = 'unknown';
    this._timer = null;
    this._db = null;
  }

  start(db) {
    this._db = db;
    this._check(); // immediate first check
    this._timer = setInterval(() => this._check(), CHECK_INTERVAL_MS);
    console.log('[Connectivity] Monitor started (interval: 1 min).');
  }

  stop() {
    clearInterval(this._timer);
  }

  getStatus() {
    return this.status;
  }

  async _check() {
    let newStatus;
    try {
      await dnsResolve('google.com');
      newStatus = 'online';
    } catch {
      newStatus = 'offline';
    }

    if (newStatus === this.status) return;

    const previous = this.status;
    this.status = newStatus;

    try {
      await this._db.insertConnectivityLog(newStatus);
    } catch (err) {
      console.warn('[Connectivity] DB log error:', err.message);
    }

    console.log(`[Connectivity] Status changed: ${previous} → ${newStatus}`);

    if (newStatus === 'offline') {
      console.warn('[Connectivity] Internet connection lost. Events will continue to be recorded locally.');
    }

    if (newStatus === 'online' && previous === 'offline') {
      await this._onRestored();
    }
  }

  async _onRestored() {
    try {
      const lastOffline = await this._db.getLastOfflineEntry();
      if (!lastOffline) return;

      const offlineStart = new Date(lastOffline.timestamp);
      const now = new Date();
      const durationMs = now - offlineStart;
      const durationMin = Math.round(durationMs / 60000);

      const eventCount = await this._db.countEventsInPeriod(offlineStart, now);

      console.log(
        `[Connectivity] ✓ Connection restored!\n` +
        `  Offline period : ${offlineStart.toISOString()} → ${now.toISOString()}\n` +
        `  Duration       : ~${durationMin} minute(s)\n` +
        `  Events recorded: ${eventCount}`
      );

      await this._db.insertEvent({
        type:         'connection_restored',
        confidence:   null,
        snapshotPath: null,
      });
    } catch (err) {
      console.error('[Connectivity] Error in onRestored:', err.message);
    }
  }
}

module.exports = ConnectivityMonitor;
