'use strict';

const express = require('express');
const path    = require('path');
const routes  = require('./routes');
const auth    = require('../auth');
const config  = require('../config');

function createServer(db, connectivity, camera) {
  const app = express();

  app.use(express.json());

  // Serve frontend
  app.use(express.static(path.join(__dirname, '../public')));

  // Protect all data endpoints with the shared access token.
  app.use(['/events', '/status', '/clip', '/snapshot', '/snapshots', '/api'], auth.requireAuth);

  // Serve snapshot images under /snapshots/*
  app.use('/snapshots', express.static(path.resolve(config.snapshotsDir)));

  routes.setup(app, db, connectivity, camera);

  return app;
}

module.exports = { createServer };
