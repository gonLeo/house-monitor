'use strict';

const { WebSocketServer, WebSocket } = require('ws');

const MAX_BUFFERED_BYTES = 512 * 1024;
const PREVIEW_FRAME_SKIP = 3;

class WsServer {
  constructor(httpServer) {
    this.wss = new WebSocketServer({ server: httpServer, perMessageDeflate: false });
    this._frameCount = 0;
    this._lastFrameCount = 0;
    this._previewFrameCounter = 0;

    this.wss.on('connection', (ws) => {
      ws._backpressureLogged = false;
      console.log('[WS] Client connected. Total:', this.wss.clients.size);

      if (ws._socket) {
        ws._socket.on('error', (err) => {
          console.warn('[WS] Socket error:', err.message);
        });
      }

      ws.on('close', () => {
        console.log('[WS] Client disconnected. Total:', this.wss.clients.size);
      });
      ws.on('error', (err) => {
        console.warn('[WS] Client error:', err.message);
      });
    });

    this.wss.on('error', (err) => {
      console.warn('[WS] Server error:', err.message);
    });

    // Compute and broadcast FPS every second
    setInterval(() => {
      const fps = this._frameCount - this._lastFrameCount;
      this._lastFrameCount = this._frameCount;
      this.broadcast({ type: 'fps', value: fps });
    }, 1000);
  }

  /**
   * Broadcast a raw JPEG preview frame. Tracks FPS.
   * Sending binary JPEGs avoids the CPU and bandwidth overhead of base64.
   * @param {Buffer} jpegBuffer
   */
  broadcastFrame(jpegBuffer) {
    this._frameCount++;
    if (this.wss.clients.size === 0) return;

    this._previewFrameCounter++;
    if (this._previewFrameCounter % PREVIEW_FRAME_SKIP !== 0) return;

    this._sendBinaryToAll(jpegBuffer);
  }

  /**
   * Broadcast any JSON-serialisable message to all connected clients.
   * @param {object} message
   */
  broadcast(message) {
    if (this.wss.clients.size === 0) return;
    const data = JSON.stringify(message);
    this._sendToAll(data);
  }

  _sendBinaryToAll(buffer) {
    for (const client of this.wss.clients) {
      if (client.readyState !== WebSocket.OPEN) continue;

      const bufferedAmount = client.bufferedAmount || 0;
      if (bufferedAmount > MAX_BUFFERED_BYTES) {
        if (!client._backpressureLogged) {
          client._backpressureLogged = true;
          console.warn('[WS] Dropping preview frames for a slow client. bufferedAmount=', bufferedAmount);
        }
        continue;
      }

      client._backpressureLogged = false;

      try {
        client.send(buffer, { binary: true, compress: false }, (err) => {
          if (err && err.code !== 'ECONNRESET' && err.code !== 'ERR_STREAM_DESTROYED') {
            console.warn('[WS] Send error:', err.message);
          }
        });
      } catch (err) {
        console.warn('[WS] Unexpected send failure:', err.message);
        try { client.terminate(); } catch { /* ignore */ }
      }
    }
  }

  _sendToAll(data) {
    for (const client of this.wss.clients) {
      if (client.readyState !== WebSocket.OPEN) continue;

      try {
        client.send(data, { compress: false }, (err) => {
          if (err && err.code !== 'ECONNRESET' && err.code !== 'ERR_STREAM_DESTROYED') {
            console.warn('[WS] Send error:', err.message);
          }
        });
      } catch (err) {
        console.warn('[WS] Unexpected send failure:', err.message);
        try { client.terminate(); } catch { /* ignore */ }
      }
    }
  }

  getClientCount() {
    return this.wss.clients.size;
  }
}

module.exports = WsServer;
