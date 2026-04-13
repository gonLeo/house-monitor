'use strict';

const express = require('express');
const path    = require('path');
const routes  = require('./routes');

function createServer(db, connectivity, camera) {
  const app = express();

  app.use(express.json());

  // Serve frontend
  app.use(express.static(path.join(__dirname, '../public')));

  // Serve snapshot images under /snapshots/*
  app.use('/snapshots', express.static(path.resolve(process.cwd(), 'snapshots')));

  routes.setup(app, db, connectivity, camera);

  return app;
}

module.exports = { createServer };
