// ── WebSocket ─────────────────────────────────────────────────
let ws = null;
let wsReconnectTimer = null;

function connectWs() {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  ws = new WebSocket(`${proto}//${location.host}`);

  ws.onopen = () => {
    document.getElementById('ws-status').textContent = 'conectado';
    document.getElementById('ws-status').style.color = 'var(--green)';
    clearTimeout(wsReconnectTimer);
  };

  ws.onclose = () => {
    document.getElementById('ws-status').textContent = 'desconectado';
    document.getElementById('ws-status').style.color = 'var(--red)';
    wsReconnectTimer = setTimeout(connectWs, 3000);
  };

  ws.onerror = () => {};

  ws.onmessage = (e) => {
    let msg;
    try { msg = JSON.parse(e.data); } catch { return; }
    switch (msg.type) {
      case 'frame':         handleFrame(msg.data);    break;
      case 'fps':           handleFps(msg.value);     break;
      case 'detection':     handleDetection(msg.event); break;
      case 'camera_status': handleCameraStatus(msg.status); break;
    }
  };
}

// ── Frame display ─────────────────────────────────────────────
const streamImg   = document.getElementById('stream-img');
const placeholder = document.getElementById('stream-placeholder');
let firstFrame = true;

function handleFrame(base64) {
  if (firstFrame) {
    placeholder.style.display = 'none';
    streamImg.style.display = 'block';
    firstFrame = false;
    setCamStatus('online');
  }
  streamImg.src = 'data:image/jpeg;base64,' + base64;
}

function handleFps(value) {
  document.getElementById('fps-val').textContent = value;
}

// ── Alarm feature flag ────────────────────────────────────────
const alarmToggle = document.getElementById('alarm-enabled');

async function fetchAlarmState() {
  try {
    const res = await fetch('/api/alarm');
    const { enabled } = await res.json();
    alarmToggle.checked = enabled;
  } catch {}
}

alarmToggle.addEventListener('change', async () => {
  try {
    await fetch('/api/alarm', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: alarmToggle.checked }),
    });
  } catch {}
});

// ── Notifications feature flag ────────────────────────────────
const notificationsToggle = document.getElementById('notifications-enabled');

async function fetchNotificationsState() {
  try {
    const res = await fetch('/api/notifications');
    const { enabled } = await res.json();
    notificationsToggle.checked = enabled;
  } catch {}
}

notificationsToggle.addEventListener('change', async () => {
  try {
    await fetch('/api/notifications', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: notificationsToggle.checked }),
    });
  } catch {}
});

// ── Detection notification ────────────────────────────────────
let flashTimer = null;

function handleDetection(event) {
  const flash = document.getElementById('detection-flash');
  flash.style.display = 'block';
  clearTimeout(flashTimer);
  flashTimer = setTimeout(() => { flash.style.display = 'none'; }, 4000);

  prependEventCard(event);
  updateEventsCount(1);
}

// ── Camera status ─────────────────────────────────────────────
function setCamStatus(status) {
  const dot   = document.getElementById('cam-dot');
  const label = document.getElementById('cam-label');
  dot.style.background  = status === 'online' ? 'var(--green)' : 'var(--red)';
  dot.style.boxShadow   = status === 'online' ? '0 0 6px var(--green)' : '0 0 6px var(--red)';
  label.textContent = status === 'online' ? 'ok' : 'off';
}

function handleCameraStatus(status) {
  if (status === 'disconnected') setCamStatus('offline');
}

// ── Connectivity status ───────────────────────────────────────
function setConnStatus(status) {
  const dot   = document.getElementById('conn-dot');
  const label = document.getElementById('conn-label');
  dot.className = 'dot ' + status;
  label.textContent = status === 'online' ? 'online' : status === 'offline' ? 'offline' : 'verificando…';
}

// ── Events list ───────────────────────────────────────────────
let _eventsCount = 0;

function updateEventsCount(delta) {
  _eventsCount += delta;
  document.getElementById('events-count').textContent = _eventsCount;
}

function formatDuration(startTs, endTs) {
  const secs = Math.max(0, Math.round((new Date(endTs) - new Date(startTs)) / 1000));
  if (secs < 60) return `${secs}s`;
  return `${Math.floor(secs / 60)}m ${secs % 60}s`;
}

function formatTs(ts) {
  return new Date(ts).toLocaleString('pt-BR', {
    day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
}

function buildEventCard(ev) {
  const item = document.createElement('div');
  item.className = 'event-item';
  item.dataset.id = ev.id;

  let thumbHtml;
  if (ev.snapshot_path) {
    thumbHtml = `<img class="event-thumb" src="/snapshots/event-${ev.id}.jpg" alt="snapshot"
      onerror="this.style.display='none';this.nextElementSibling.style.display='flex'">
      <div class="event-thumb-placeholder" style="display:none">📷</div>`;
  } else {
    thumbHtml = `<div class="event-thumb-placeholder">
      ${ev.type === 'connection_restored' ? '🔗' : '⚡'}
    </div>`;
  }

  const confHtml = ev.confidence
    ? `<div class="event-conf">conf: ${(ev.confidence * 100).toFixed(1)}%</div>`
    : '';

  const durHtml = ev.ended_at
    ? `<div class="event-conf">duração: ${formatDuration(ev.timestamp, ev.ended_at)}</div>`
    : '';

  const typeClass = ev.type === 'connection_restored' ? 'connection_restored' : '';

  // Clip button: only enable once the segment covering the event end is finalised.
  // Segments take ~60s to record; allow 70s after ended_at before enabling.
  // Events without ended_at are still ongoing — button stays disabled.
  const CLIP_READY_MS  = 70 * 1000;
  const endedAtMs      = ev.ended_at ? new Date(ev.ended_at).getTime() : NaN;
  const clipReady      = !isNaN(endedAtMs) && (Date.now() - endedAtMs) > CLIP_READY_MS;
  const clipBtn = clipReady
    ? `<button class="btn-clip" onclick="openClipViewer('${ev.timestamp}', '${ev.ended_at}')">▶ Ver Clipe</button>`
    : `<button class="btn-clip" disabled title="Disponível ~70s após o fim do evento">⏳ Processando…</button>`;

  item.innerHTML = `
    ${thumbHtml}
    <div class="event-info">
      <div class="event-type ${typeClass}">${ev.type.replace(/_/g, ' ')}</div>
      <div class="event-ts">${formatTs(ev.timestamp)}</div>
      ${confHtml}
      ${durHtml}
      ${clipBtn}
    </div>`;
  return item;
}

function prependEventCard(ev) {
  const list  = document.getElementById('events-list');
  const empty = document.getElementById('events-empty');
  if (empty) empty.remove();
  list.insertBefore(buildEventCard(ev), list.firstChild);
}

async function loadEvents() {
  const start = document.getElementById('filter-start').value;
  const end   = document.getElementById('filter-end').value;

  let url = '/events?';
  if (start) url += `startTime=${encodeURIComponent(new Date(start).toISOString())}&`;
  if (end)   url += `endTime=${encodeURIComponent(new Date(end).toISOString())}&`;

  let events;
  try {
    const r = await fetch(url);
    events = await r.json();
  } catch { return; }

  const list = document.getElementById('events-list');
  list.innerHTML = '';
  _eventsCount = events.length;
  document.getElementById('events-count').textContent = _eventsCount;

  if (events.length === 0) {
    list.innerHTML = '<div id="events-empty">Nenhum evento encontrado.</div>';
    return;
  }

  const frag = document.createDocumentFragment();
  for (const ev of events) frag.appendChild(buildEventCard(ev));
  list.appendChild(frag);
}

function clearFilter() {
  document.getElementById('filter-start').value = '';
  document.getElementById('filter-end').value   = '';
  loadEvents();
}

// ── Connectivity history ──────────────────────────────────────
async function loadConnectivity() {
  let data;
  try {
    const r = await fetch('/status');
    data = await r.json();
  } catch { return; }

  setConnStatus(data.connectivity || 'unknown');

  if (data.cameraRunning !== undefined) {
    setCamStatus(data.cameraRunning ? 'online' : 'offline');
  }

  const hist      = data.connectivityHistory || [];
  const container = document.getElementById('conn-history');
  container.innerHTML = '';

  if (hist.length === 0) {
    container.innerHTML = '<div style="padding:12px 0;color:var(--muted);font-size:12px;">Sem registros.</div>';
    return;
  }

  for (const entry of hist) {
    const item = document.createElement('div');
    item.className = 'conn-item';
    item.innerHTML = `
      <span class="conn-status ${entry.status}">${entry.status.toUpperCase()}</span>
      <span class="conn-ts">${formatTs(entry.timestamp)}</span>`;
    container.appendChild(item);
  }
}

// ── Clip viewer modal ─────────────────────────────────────────
const CLIP_PADDING_MS = 10 * 1000; // 10s before/after the event window
let _clipObjectUrl = null;

async function openClipViewer(timestamp, endedAt) {
  const eventStart = new Date(timestamp);
  const eventEnd   = endedAt ? new Date(endedAt) : eventStart;
  const start = new Date(eventStart.getTime() - CLIP_PADDING_MS);
  const end   = new Date(eventEnd.getTime()   + CLIP_PADDING_MS);
  const url   = `/clip?startTime=${encodeURIComponent(start.toISOString())}&endTime=${encodeURIComponent(end.toISOString())}`;

  const overlay  = document.getElementById('clip-modal-overlay');
  const video    = document.getElementById('clip-modal-video');
  const loading  = document.getElementById('clip-modal-loading');
  const title    = document.getElementById('clip-modal-title');
  const download = document.getElementById('clip-modal-download');

  title.textContent = `Clipe — ${formatTs(timestamp)}`;
  video.style.display   = 'none';
  loading.style.display = 'block';
  loading.innerHTML     = '<div class="spinner"></div><br>Gerando clipe…';
  download.style.display = 'none';
  overlay.classList.add('open');

  if (_clipObjectUrl) { URL.revokeObjectURL(_clipObjectUrl); _clipObjectUrl = null; }

  try {
    const res = await fetch(url);
    if (!res.ok) {
      let msg = `Erro ${res.status}`;
      try { const j = await res.json(); msg = j.error || msg; } catch { /* ignore */ }
      loading.innerHTML = `⚠ ${msg}`;
      return;
    }

    const blob = await res.blob();
    _clipObjectUrl = URL.createObjectURL(blob);
    video.src = _clipObjectUrl;
    loading.style.display = 'none';
    video.style.display   = 'block';
    download.href         = _clipObjectUrl;
    download.download     = `clip-${Date.now()}.mp4`;
    download.style.display = 'inline-block';
    video.play().catch(() => {});
  } catch (err) {
    loading.innerHTML = `⚠ Falha ao carregar o clipe: ${err.message}`;
  }
}

function closeClipViewer() {
  const video = document.getElementById('clip-modal-video');
  video.pause();
  video.src = '';
  if (_clipObjectUrl) { URL.revokeObjectURL(_clipObjectUrl); _clipObjectUrl = null; }
  document.getElementById('clip-modal-overlay').classList.remove('open');
  document.getElementById('clip-modal-loading').innerHTML = '<div class="spinner"></div><br>Gerando clipe…';
  document.getElementById('clip-modal-video').style.display   = 'none';
  document.getElementById('clip-modal-download').style.display = 'none';
}

// ── Clip link generator ───────────────────────────────────────
function buildClipLink() {
  const start = document.getElementById('clip-start').value;
  const end   = document.getElementById('clip-end').value;
  if (!start || !end) { alert('Selecione data/hora de início e fim.'); return; }
  const url  = `/clip?startTime=${encodeURIComponent(new Date(start).toISOString())}&endTime=${encodeURIComponent(new Date(end).toISOString())}`;
  const link = document.getElementById('clip-link');
  link.href         = url;
  link.style.display = 'block';
}

// ── Storage usage ─────────────────────────────────────────────
function formatBytes(bytes) {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(2)} MB`;
  return `${(bytes / 1024).toFixed(2)} KB`;
}

function renderStorageUsage(data) {
  document.getElementById('storage-total').textContent = formatBytes(data.totalBytes);
  const d = new Date(data.calculatedAt);
  document.getElementById('storage-ts').textContent =
    `atualizado ${d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}`;
}

async function fetchStorageUsage() {
  try {
    const r = await fetch('/api/storage-usage');
    renderStorageUsage(await r.json());
  } catch {}
}

async function refreshStorageUsage() {
  document.getElementById('storage-total').textContent = '…';
  document.getElementById('storage-ts').textContent = '';
  try {
    const r = await fetch('/api/storage-usage/refresh', { method: 'POST' });
    renderStorageUsage(await r.json());
  } catch {}
}

// ── Cleanup modal ─────────────────────────────────────
function openCleanupModal() {
  document.getElementById('cleanup-result').style.display = 'none';
  document.getElementById('cleanup-confirm-btn').disabled = false;
  document.getElementById('cleanup-confirm-btn').textContent = 'Confirmar limpeza';
  // Fetch current retention config from /status to display in warning text
  fetch('/status').then(r => r.json()).then(data => {
    const hours = data.retentionHours;
    if (hours) {
      const label = hours >= 24 ? `${hours / 24}d` : `${hours}h`;
      document.getElementById('cleanup-retention-label').textContent = label;
    }
  }).catch(() => {});
  document.getElementById('cleanup-modal-overlay').classList.add('open');
}

function closeCleanupModal() {
  document.getElementById('cleanup-modal-overlay').classList.remove('open');
}

async function confirmCleanup() {
  const btn = document.getElementById('cleanup-confirm-btn');
  btn.disabled = true;
  btn.textContent = 'Limpando…';
  const resultEl = document.getElementById('cleanup-result');
  resultEl.style.display = 'none';
  try {
    const r = await fetch('/api/cleanup/run', { method: 'POST' });
    const { removedBytes, filesCount } = await r.json();
    resultEl.style.display = 'block';
    resultEl.style.color = 'var(--green)';
    resultEl.textContent =
      `✅ Limpeza concluída: ${filesCount} arquivo(s) removido(s) (${formatBytes(removedBytes)}).`;
    // Refresh storage badge
    fetchStorageUsage();
    btn.textContent = 'Concluído';
  } catch {
    resultEl.style.display = 'block';
    resultEl.style.color = 'var(--red)';
    resultEl.textContent = '❌ Erro ao executar limpeza. Verifique os logs.';
    btn.disabled = false;
    btn.textContent = 'Confirmar limpeza';
  }
}

// ── Init ──────────────────────────────────────────────────────
connectWs();
loadEvents();
loadConnectivity();
fetchAlarmState();
fetchNotificationsState();
fetchStorageUsage();

setInterval(loadConnectivity, 30000);
setInterval(fetchStorageUsage, 30 * 60 * 1000);
setInterval(() => {
  const s = document.getElementById('filter-start').value;
  const e = document.getElementById('filter-end').value;
  if (!s && !e) loadEvents();
}, 30000);
