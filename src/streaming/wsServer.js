'use strict';

const { WebSocketServer, WebSocket } = require('ws');

class WsServer {
  constructor(httpServer) {
    this.wss = new WebSocketServer({ server: httpServer });
    this._frameCount = 0;
    this._lastFrameCount = 0;

    this.wss.on('connection', (ws) => {
      console.log('[WS] Client connected. Total:', this.wss.clients.size);
      ws.on('close', () => {
        console.log('[WS] Client disconnected. Total:', this.wss.clients.size);
      });
      ws.on('error', (err) => {
        console.warn('[WS] Client error:', err.message);
      });
    });

    // Compute and broadcast FPS every second
    setInterval(() => {
      const fps = this._frameCount - this._lastFrameCount;
      this._lastFrameCount = this._frameCount;
      this.broadcast({ type: 'fps', value: fps });
    }, 1000);
  }

  /**
   * Broadcast a JPEG frame as base64. Tracks FPS.
   * @param {string} base64
   */
  broadcastFrame(base64) {
    this._frameCount++;
    if (this.wss.clients.size === 0) return;
    const data = JSON.stringify({ type: 'frame', data: base64 });
    this._sendToAll(data);
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

  _sendToAll(data) {
    for (const client of this.wss.clients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(data, (err) => {
          if (err && err.code !== 'ECONNRESET') {
            console.warn('[WS] Send error:', err.message);
          }
        });
      }
    }
  }

  getClientCount() {
    return this.wss.clients.size;
  }
}

module.exports = WsServer;
