'use strict';

const { pool } = require('./connection');

async function insertEvent({ type, confidence = null, snapshotPath = null }) {
  const result = await pool.query(
    `INSERT INTO events (type, confidence, snapshot_path)
     VALUES ($1, $2, $3)
     RETURNING *`,
    [type, confidence, snapshotPath]
  );
  return result.rows[0];
}

async function updateEventSnapshot(id, snapshotPath) {
  await pool.query(
    'UPDATE events SET snapshot_path = $1 WHERE id = $2',
    [snapshotPath, id]
  );
}

async function updateEventEndedAt(id, endedAt) {
  await pool.query(
    'UPDATE events SET ended_at = $1 WHERE id = $2',
    [endedAt, id]
  );
}

async function getEvents({ startTime, endTime, synced, type } = {}) {
  const conditions = [];
  const params = [];

  if (startTime) {
    params.push(startTime);
    conditions.push(`timestamp >= $${params.length}`);
  }
  if (endTime) {
    params.push(endTime);
    conditions.push(`timestamp <= $${params.length}`);
  }
  if (synced !== undefined && synced !== null && synced !== '') {
    params.push(synced === 'true' || synced === true);
    conditions.push(`synced = $${params.length}`);
  }
  if (type) {
    params.push(type);
    conditions.push(`type = $${params.length}`);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const result = await pool.query(
    `SELECT * FROM events ${where} ORDER BY timestamp DESC LIMIT 500`,
    params
  );
  return result.rows;
}

async function getEventById(id) {
  const result = await pool.query('SELECT * FROM events WHERE id = $1', [id]);
  return result.rows[0] || null;
}

async function insertConnectivityLog(status) {
  const result = await pool.query(
    'INSERT INTO connectivity_log (status) VALUES ($1) RETURNING *',
    [status]
  );
  return result.rows[0];
}

async function getConnectivityLogs(limit = 20) {
  const result = await pool.query(
    'SELECT * FROM connectivity_log ORDER BY timestamp DESC LIMIT $1',
    [limit]
  );
  return result.rows;
}

async function getLastOfflineEntry() {
  const result = await pool.query(
    `SELECT * FROM connectivity_log WHERE status = 'offline' ORDER BY timestamp DESC LIMIT 1`
  );
  return result.rows[0] || null;
}

async function countEventsInPeriod(start, end) {
  const result = await pool.query(
    `SELECT COUNT(*) FROM events
     WHERE timestamp >= $1 AND timestamp <= $2 AND type != 'connection_restored'`,
    [start, end]
  );
  return parseInt(result.rows[0].count, 10);
}

async function getLastEvent() {
  const result = await pool.query(
    'SELECT * FROM events ORDER BY timestamp DESC LIMIT 1'
  );
  return result.rows[0] || null;
}

module.exports = {
  insertEvent,
  updateEventSnapshot,
  updateEventEndedAt,
  getEvents,
  getEventById,
  insertConnectivityLog,
  getConnectivityLogs,
  getLastOfflineEntry,
  countEventsInPeriod,
  getLastEvent,
};
