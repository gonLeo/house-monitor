'use strict';

const https  = require('https');
const config = require('../config');

// ─── Formatting helpers ───────────────────────────────────────────────────────

function formatDateTime(date = new Date()) {
  return date.toLocaleString('pt-BR', {
    day:    '2-digit',
    month:  '2-digit',
    year:   'numeric',
    hour:   '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

function formatDuration(ms) {
  const total = Math.round(ms / 1000);
  const h     = Math.floor(total / 3600);
  const m     = Math.floor((total % 3600) / 60);
  const s     = total % 60;
  if (h > 0) return `${h}h ${m}min ${s}s`;
  if (m > 0) return `${m}min ${s}s`;
  return `${s}s`;
}

function formatBytes(bytes) {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(2)} MB`;
  return `${(bytes / 1024).toFixed(2)} KB`;
}

// ─── NtfyNotifier ────────────────────────────────────────────────────────────

class NtfyNotifier {
  constructor() {
    this.topic   = config.ntfyTopic;
    this.enabled = !!this.topic;
    if (!this.enabled) {
      console.warn('[Ntfy] NTFY_TOPIC not configured — push notifications disabled.');
    }
  }

  /**
   * Low-level fire-and-forget POST to ntfy.sh.
   * Errors are logged as warnings and never propagated.
   */
  _send({ title, priority = 'default', tags = [], body }) {
    if (!this.enabled) return;

    const data    = Buffer.from(body, 'utf8');
    const options = {
      hostname: 'ntfy.sh',
      port:     443,
      path:     `/${this.topic}`,
      method:   'POST',
      headers:  {
        'Title':          title,
        'Priority':       priority,
        'Tags':           tags.join(','),
        'Content-Type':   'text/plain; charset=utf-8',
        'Content-Length': data.length,
      },
    };

    const req = https.request(options, (res) => {
      if (res.statusCode !== 200) {
        console.warn(`[Ntfy] Notification failed: HTTP ${res.statusCode} — "${title}"`);
      }
      res.resume(); // drain response to free socket
    });

    req.on('error', (err) => {
      console.warn('[Ntfy] Failed to send notification:', err.message);
    });

    req.write(data);
    req.end();
  }

  // ─── Notification methods ─────────────────────────────────────────────────

  /**
   * Fired every time a person is confirmed detected by the pipeline.
   * @param {{ confidence: number }} opts
   */
  personDetected({ confidence }) {
    const now = new Date();
    this._send({
      title:    'ALERTA DE PRESENÇA DETECTADA',
      priority: 'high',
      tags:     ['police_car_light', 'house'],
      body:
        `🚨 Presença humana detectada na câmera!\n\n` +
        `⏰ Horário: ${formatDateTime(now)}\n` +
        `🎯 Confiança: ${(confidence * 100).toFixed(1)}%\n\n` +
        `⚠️ Verifique o sistema de monitoramento.`,
    });
  }

  /**
   * Fired once when the camera stream drops.
   * The system retries indefinitely (exponential backoff, max 30 s delay).
   */
  cameraDisconnected() {
    const now = new Date();
    this._send({
      title:    'CÂMERA DESCONECTADA',
      priority: 'high',
      tags:     ['warning', 'camera_with_flash'],
      body:
        `📷 Câmera desconectada!\n\n` +
        `⏰ Horário: ${formatDateTime(now)}\n\n` +
        `🔄 O sistema está tentando reconectar automaticamente.\n` +
        `   (tentativas a cada 1 s → 2 s → 4 s → … até 30 s)`,
    });
  }

  /**
   * Fired once when the camera stream is re-established.
   * @param {{ downtimeMs: number }} opts
   */
  cameraReconnected({ downtimeMs }) {
    const now = new Date();
    this._send({
      title:    'CÂMERA RECONECTADA',
      priority: 'default',
      tags:     ['white_check_mark', 'camera_with_flash'],
      body:
        `✅ Câmera reconectada com sucesso!\n\n` +
        `⏰ Horário: ${formatDateTime(now)}\n` +
        `⏱️ Tempo offline: ${formatDuration(downtimeMs)}\n\n` +
        `📹 Monitoramento retomado normalmente.`,
    });
  }

  /**
   * Fired when DNS connectivity check first returns offline.
   */
  connectivityLost() {
    const now = new Date();
    this._send({
      title:    'CONEXÃO COM INTERNET PERDIDA',
      priority: 'high',
      tags:     ['warning', 'globe_with_meridians'],
      body:
        `🔌 Conexão com internet perdida!\n\n` +
        `⏰ Horário: ${formatDateTime(now)}\n\n` +
        `📼 Eventos continuarão sendo gravados localmente.`,
    });
  }

  /**
   * Fired when connectivity comes back after an offline period.
   * @param {{ offlineDurationMs: number, events: Array }} opts
   *   events: DB rows with at least { type, timestamp } recorded during the outage.
   */
  connectivityRestored({ offlineDurationMs, events = [] }) {
    const now = new Date();
    let body =
      `🌐 Conexão com internet restaurada!\n\n` +
      `⏰ Horário: ${formatDateTime(now)}\n` +
      `⏱️ Tempo offline: ${formatDuration(offlineDurationMs)}\n` +
      `📊 Eventos durante a queda: ${events.length}\n`;

    if (events.length > 0) {
      body += `\n📋 Eventos detectados durante a queda:\n`;
      for (const ev of events) {
        const ts    = formatDateTime(new Date(ev.timestamp));
        const label = ev.type === 'person_detected'
          ? '👤 Pessoa detectada'
          : `📌 ${ev.type}`;
        body += `  • ${label} — ${ts}\n`;
      }
    }

    this._send({
      title:    'CONEXÃO RESTAURADA',
      priority: 'default',
      tags:     ['globe_with_meridians', 'white_check_mark'],
      body,
    });
  }

  /**
   * Fired after the hourly cleanup job removes old files.
   * Skipped silently if nothing was actually deleted.
   *
   * @param {{ removedBytes: number, filesCount: number, retentionHours: number }} opts
   */
  cleanupDone({ removedBytes, filesCount, retentionHours }) {
    if (removedBytes === 0 && filesCount === 0) return;

    const now            = new Date();
    const retentionDays  = retentionHours / 24;
    const avgBytesPerDay = retentionDays > 0 ? removedBytes / retentionDays : removedBytes;

    this._send({
      title:    'LIMPEZA AUTOMÁTICA REALIZADA',
      priority: 'low',
      tags:     ['broom', 'floppy_disk'],
      body:
        `🧹 Limpeza automática concluída!\n\n` +
        `⏰ Horário: ${formatDateTime(now)}\n` +
        `🗑️ Volume removido: ${formatBytes(removedBytes)} (${filesCount} arquivo(s))\n` +
        `📈 Média por dia (janela ${retentionHours}h): ${formatBytes(avgBytesPerDay)}/dia\n\n` +
        `💾 Espaço liberado com sucesso.`,
    });
  }
}

module.exports = new NtfyNotifier();
