'use strict';

const fs   = require('fs');
const path = require('path');
const util = require('util');

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

  let fileLoggingAvailable = true;

  stream.on('error', (err) => {
    fileLoggingAvailable = false;
    try {
      origWarn('[Logger] File logging disabled:', err.message);
    } catch {
      // ignore terminal write errors too
    }
  });

  for (const output of [process.stdout, process.stderr]) {
    if (!output || typeof output.on !== 'function') continue;
    output.on('error', (err) => {
      try {
        stream.write(`[${new Date().toISOString()}] [LOGGER] Output stream error: ${err.message}\n`);
      } catch {
        // ignore recursive write failures
      }
    });
  }

  function wrap(orig, level) {
    return (...args) => {
      const message = util.format(...args);

      try {
        orig(message);
      } catch {
        // stdout/stderr can fail under memory pressure on Windows; keep app alive
      }

      if (!fileLoggingAvailable) return;

      const prefix = `[${new Date().toISOString()}] [${level}] `;
      try {
        stream.write(prefix + message + '\n');
      } catch {
        fileLoggingAvailable = false;
      }
    };
  }

  console.log   = wrap(origLog,   'INFO');
  console.warn  = wrap(origWarn,  'WARN');
  console.error = wrap(origError, 'ERROR');
}

module.exports = { init };
