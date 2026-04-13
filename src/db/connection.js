'use strict';

const { Pool } = require('pg');
const config = require('../config');

const pool = new Pool({
  host:                  config.db.host,
  port:                  config.db.port,
  database:              config.db.database,
  user:                  config.db.user,
  password:              config.db.password,
  max:                   10,
  idleTimeoutMillis:     30000,
  connectionTimeoutMillis: 5000,
});

pool.on('error', (err) => {
  console.error('[DB] Unexpected pool error:', err.message);
});

/**
 * Wait for the database to become available (needed when Docker is starting up).
 * Retries up to maxRetries times with delayMs between each attempt.
 */
async function waitForConnection(maxRetries = 12, delayMs = 5000) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const client = await pool.connect();
      client.release();
      console.log('[DB] Connection established.');
      return;
    } catch (err) {
      console.warn(`[DB] Attempt ${attempt}/${maxRetries} failed: ${err.message}`);
      if (attempt === maxRetries) {
        throw new Error('[DB] Could not connect to PostgreSQL after max retries. Is Docker running?');
      }
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
}

module.exports = { pool, waitForConnection };
