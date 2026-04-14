'use strict';

const fs   = require('fs');
const path = require('path');

/**
 * Initialises file logging. Must be called once, early in startup (after config is loaded).
 * Wraps console.log/warn/error so every line is also written to logs/app.log
 * with an ISO timestamp prefix: [2026-04-14T11:00:00.000Z] [INFO] …
 *
 * The timestamp is used by cleanup.js to trim lines older than the retention window.
 */
function init(logsDir) {
  fs.mkdirSync(logsDir, { recursive: true });
  const stream = fs.createWriteStream(path.join(logsDir, 'app.log'), { flags: 'a' });

  // Capture originals BEFORE replacing, to avoid infinite recursion.
  const origLog   = console.log.bind(console);
  const origWarn  = console.warn.bind(console);
  const origError = console.error.bind(console);

  function wrap(orig, level) {
    return (...args) => {
      orig(...args);
      const prefix = `[${new Date().toISOString()}] [${level}] `;
      stream.write(prefix + args.map(String).join(' ') + '\n');
    };
  }

  console.log   = wrap(origLog,   'INFO');
  console.warn  = wrap(origWarn,  'WARN');
  console.error = wrap(origError, 'ERROR');
}

module.exports = { init };
