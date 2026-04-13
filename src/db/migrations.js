'use strict';

const fs   = require('fs');
const path = require('path');
const { pool } = require('./connection');

async function runMigrations() {
  const schemaPath = path.join(__dirname, '../../sql/schema.sql');
  const sql = fs.readFileSync(schemaPath, 'utf8');
  try {
    await pool.query(sql);
    console.log('[DB] Migrations applied successfully.');
  } catch (err) {
    console.error('[DB] Migration error:', err.message);
    throw err;
  }
}

module.exports = { runMigrations };
