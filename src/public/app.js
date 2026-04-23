// ── Access token / auth ───────────────────────────────────────
const ACCESS_TOKEN_KEY = 'houseMonitorAccessToken';
const authOverlay = document.getElementById('auth-overlay');
const authForm = document.getElementById('auth-form');
const authInput = document.getElementById('access-token-input');
const authError = document.getElementById('auth-error');

let ws = null;
let wsReconnectTimer = null;
let authAlertVisible = false;
let authFlowPromise = null;
let authFlowResolve = null;
let pollingStarted = false;

function getAccessToken() {
  return localStorage.getItem(ACCESS_TOKEN_KEY) || '';
}

function saveAccessToken(token) {
  localStorage.setItem(ACCESS_TOKEN_KEY, token);
  updateProtectedLinks();
}

function clearAccessToken() {
  localStorage.removeItem(ACCESS_TOKEN_KEY);
  updateProtectedLinks();
}

function withAccessToken(url) {
  const token = getAccessToken();
  if (!token) return url;

  const absoluteUrl = new URL(url, window.location.origin);
  absoluteUrl.searchParams.set('token', token);
  return `${absoluteUrl.pathname}${absoluteUrl.search}${absoluteUrl.hash}`;
}

function updateProtectedLinks() {
  const logsLink = document.querySelector('.btn-logs');
  if (logsLink) logsLink.href = withAccessToken('/api/logs');
}

function setAuthOverlay(visible, message = '') {
  authOverlay.classList.toggle('open', visible);
  document.body.classList.toggle('auth-locked', visible);
  authError.textContent = message;
  if (visible) setTimeout(() => authInput.focus(), 50);
}

function beginAuthFlow(message = '') {
  setAuthOverlay(true, message);
  if (!authFlowPromise) {
    authFlowPromise = new Promise((resolve) => {
      authFlowResolve = resolve;
    });
  }
  return authFlowPromise;
}

async function validateAccessToken(token) {
  try {
    const res = await fetch('/api/auth/validate', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Access-Token': token,
      },
      body: JSON.stringify({ token }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

function refreshProtectedData() {
  loadSettings();
  loadEvents();
  loadConnectivity();
  fetchStorageUsage();
}

function startPolling() {
  if (pollingStarted) return;
  pollingStarted = true;
  setInterval(loadConnectivity, 30000);
  setInterval(fetchStorageUsage, 30 * 60 * 1000);
  setInterval(() => {
    const s = document.getElementById('filter-start').value;
    const e = document.getElementById('filter-end').value;
    if (!s && !e) loadEvents();
  }, 30000);
}

function bindAuthUi() {
  if (authForm.dataset.bound === '1') return;
  authForm.dataset.bound = '1';

  authForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    const token = authInput.value.trim();

    if (!token) {
      authError.textContent = 'Informe o token de acesso.';
      return;
    }

    authError.textContent = 'Validando…';
    const valid = await validateAccessToken(token);
    if (!valid) {
      clearAccessToken();
      authError.textContent = 'Token inválido.';
      authInput.select();
      return;
    }

    saveAccessToken(token);
    authInput.value = '';
    authError.textContent = '';
    setAuthOverlay(false);
    authAlertVisible = false;

    if (authFlowResolve) {
      authFlowResolve(true);
      authFlowResolve = null;
      authFlowPromise = null;
    }

    connectWs();
    refreshProtectedData();
    startPolling();
  });
}

async function handleUnauthorized() {
  if (authAlertVisible) return;
  authAlertVisible = true;
  clearAccessToken();
  clearTimeout(wsReconnectTimer);
  try { if (ws) ws.close(); } catch {}
  await beginAuthFlow('Token ausente ou inválido. Digite novamente.');
}

async function ensureAccessToken() {
  const stored = getAccessToken();
  if (stored && await validateAccessToken(stored)) {
    saveAccessToken(stored);
    setAuthOverlay(false);
    return true;
  }

  clearAccessToken();
  return beginAuthFlow('Digite o token de acesso para liberar o painel.');
}

async function authFetch(url, options = {}) {
  const headers = new Headers(options.headers || {});
  const token = getAccessToken();
  if (token) headers.set('X-Access-Token', token);

  const response = await fetch(url, { ...options, headers });
  if (response.status === 401 || response.status === 403) {
    await handleUnauthorized();
    throw new Error('Acesso negado');
  }
  return response;
}

// ── WebSocket ─────────────────────────────────────────────────
function connectWs() {
  const tokenValue = getAccessToken();
  if (!tokenValue) return;

  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
    return;
  }

  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const token = encodeURIComponent(tokenValue);
  ws = new WebSocket(`${proto}//${location.host}/?token=${token}`);
  ws.binaryType = 'blob';

  ws.onopen = () => {
    document.getElementById('ws-status').textContent = 'conectado';
    document.getElementById('ws-status').style.color = 'var(--green)';
    clearTimeout(wsReconnectTimer);
  };

  ws.onclose = (event) => {
    document.getElementById('ws-status').textContent = 'desconectado';
    document.getElementById('ws-status').style.color = 'var(--red)';
    if (event.code === 1008) {
      handleUnauthorized().catch(() => {});
      return;
    }
    wsReconnectTimer = setTimeout(connectWs, 3000);
  };

  ws.onerror = () => {};

  ws.onmessage = (e) => {
    if (typeof e.data !== 'string') {
      handleFrameBlob(e.data);
      return;
    }

    let msg;
    try { msg = JSON.parse(e.data); } catch { return; }
    switch (msg.type) {
      case 'fps':           handleFps(msg.value);       break;
      case 'detection':     handleDetection(msg.event); break;
      case 'camera_status': handleCameraStatus(msg.status); break;
    }
  };
}

// ── Frame display ─────────────────────────────────────────────
const streamImg   = document.getElementById('stream-img');
const placeholder = document.getElementById('stream-placeholder');
const roiOverlay  = document.getElementById('roi-overlay');
const roiBox      = document.getElementById('roi-box');
const detectionModeSelect = document.getElementById('detection-mode');
let firstFrame = true;
let currentFrameUrl = null;
let currentSettings = null;
let roiEditMode = false;
let roiPointerStart = null;
let roiDraft = null;

function handleFrameBlob(blob) {
  if (firstFrame) {
    placeholder.style.display = 'none';
    streamImg.style.display = 'block';
    firstFrame = false;
    setCamStatus('online');
  }

  const nextUrl = URL.createObjectURL(blob);
  const prevUrl = currentFrameUrl;
  currentFrameUrl = nextUrl;
  streamImg.src = nextUrl;

  if (prevUrl) {
    setTimeout(() => URL.revokeObjectURL(prevUrl), 1500);
  }
}

function handleFps(value) {
  document.getElementById('fps-val').textContent = value;
}

// ── Runtime settings / feature flags ──────────────────────────
const alarmToggle = document.getElementById('alarm-enabled');
const notificationsToggle = document.getElementById('notifications-enabled');

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function renderRoi(roi = { x: 0, y: 0, w: 1, h: 1 }) {
  const isFullArea = roi.x === 0 && roi.y === 0 && roi.w === 1 && roi.h === 1;

  if (isFullArea && !roiEditMode) {
    roiBox.style.display = 'none';
    return;
  }

  roiBox.style.display = 'block';
  roiBox.style.left = `${roi.x * 100}%`;
  roiBox.style.top = `${roi.y * 100}%`;
  roiBox.style.width = `${roi.w * 100}%`;
  roiBox.style.height = `${roi.h * 100}%`;
}

async function loadSettings() {
  try {
    const res = await authFetch('/api/settings');
    currentSettings = await res.json();
    alarmToggle.checked = Boolean(currentSettings.alarmEnabled);
    notificationsToggle.checked = Boolean(currentSettings.notificationsEnabled);
    detectionModeSelect.value = currentSettings.detectionMode || 'motion_only';
    renderRoi(currentSettings.motion?.roi);
  } catch {}
}

alarmToggle.addEventListener('change', async () => {
  try {
    const res = await authFetch('/api/alarm', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: alarmToggle.checked }),
    });
    const { enabled } = await res.json();
    alarmToggle.checked = enabled;
  } catch {}
});

notificationsToggle.addEventListener('change', async () => {
  try {
    const res = await authFetch('/api/notifications', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: notificationsToggle.checked }),
    });
    const { enabled } = await res.json();
    notificationsToggle.checked = enabled;
  } catch {}
});

detectionModeSelect.addEventListener('change', async () => {
  try {
    const res = await authFetch('/api/detection-mode', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: detectionModeSelect.value }),
    });
    const { mode } = await res.json();
    detectionModeSelect.value = mode;
    if (currentSettings) currentSettings.detectionMode = mode;
  } catch {}
});

function toggleRoiEdit() {
  roiEditMode = !roiEditMode;
  roiPointerStart = null;
  roiDraft = null;
  roiOverlay.classList.toggle('editing', roiEditMode);
  document.getElementById('roi-edit-btn').textContent = roiEditMode ? '✋ Arraste na imagem' : '🎯 Definir área';
  renderRoi(currentSettings?.motion?.roi);
}

async function persistRoi(roi) {
  const res = await authFetch('/api/motion-roi', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ roi }),
  });
  const data = await res.json();
  if (currentSettings) {
    currentSettings.motion = currentSettings.motion || {};
    currentSettings.motion.roi = data.roi;
  }
  renderRoi(data.roi);
}

async function clearRoi() {
  roiEditMode = false;
  roiOverlay.classList.remove('editing');
  document.getElementById('roi-edit-btn').textContent = '🎯 Definir área';
  try {
    await persistRoi({ x: 0, y: 0, w: 1, h: 1 });
  } catch {}
}

roiOverlay.addEventListener('pointerdown', (event) => {
  if (!roiEditMode) return;
  const rect = roiOverlay.getBoundingClientRect();
  roiPointerStart = {
    x: clamp((event.clientX - rect.left) / rect.width, 0, 1),
    y: clamp((event.clientY - rect.top) / rect.height, 0, 1),
  };
  roiDraft = { ...roiPointerStart, w: 0.05, h: 0.05 };
  renderRoi(roiDraft);
});

roiOverlay.addEventListener('pointermove', (event) => {
  if (!roiEditMode || !roiPointerStart) return;
  const rect = roiOverlay.getBoundingClientRect();
  const x = clamp((event.clientX - rect.left) / rect.width, 0, 1);
  const y = clamp((event.clientY - rect.top) / rect.height, 0, 1);
  const left = Math.min(roiPointerStart.x, x);
  const top = Math.min(roiPointerStart.y, y);
  roiDraft = {
    x: left,
    y: top,
    w: Math.max(0.05, Math.abs(x - roiPointerStart.x)),
    h: Math.max(0.05, Math.abs(y - roiPointerStart.y)),
  };
  renderRoi(roiDraft);
});

window.addEventListener('pointerup', async () => {
  if (!roiEditMode || !roiPointerStart || !roiDraft) return;
  try {
    await persistRoi(roiDraft);
  } catch {}
  roiEditMode = false;
  roiPointerStart = null;
  roiDraft = null;
  roiOverlay.classList.remove('editing');
  document.getElementById('roi-edit-btn').textContent = '🎯 Definir área';
});

// ── Detection notification ────────────────────────────────────
let flashTimer = null;

function handleDetection(event) {
  const flash = document.getElementById('detection-flash');
  const isMotion = event.type === 'motion_detected';
  flash.textContent = isMotion ? '👀 Movimento detectado!' : '🚨 Pessoa detectada!';
  flash.classList.toggle('motion', isMotion);
  flash.classList.toggle('person', !isMotion);
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

  const typeIcon = ev.type === 'connection_restored'
    ? '🔗'
    : ev.type === 'motion_detected'
      ? '👀'
      : ev.type === 'person_detected'
        ? '🚨'
        : '⚡';

  let thumbHtml;
  if (ev.snapshot_path) {
    thumbHtml = `<img class="event-thumb" src="${withAccessToken(`/snapshots/event-${ev.id}.jpg`)}" alt="snapshot"
      onerror="this.style.display='none';this.nextElementSibling.style.display='flex'">
      <div class="event-thumb-placeholder" style="display:none">📷</div>`;
  } else {
    thumbHtml = `<div class="event-thumb-placeholder">${typeIcon}</div>`;
  }

  const metricLabel = ev.type === 'motion_detected' ? 'atividade' : 'conf';
  const confHtml = ev.confidence !== null && ev.confidence !== undefined
    ? `<div class="event-conf">${metricLabel}: ${(ev.confidence * 100).toFixed(1)}%</div>`
    : '';

  const durHtml = ev.ended_at
    ? `<div class="event-conf">duração: ${formatDuration(ev.timestamp, ev.ended_at)}</div>`
    : '';

  const typeClass = ev.type || '';
  const typeLabel = ev.type === 'motion_detected'
    ? 'movimento detectado'
    : ev.type === 'person_detected'
      ? 'humano detectado'
      : ev.type.replace(/_/g, ' ');

  // Clip button: only enable once the segment covering the event end is finalised.
  // Segments take ~60s to record; allow 70s after ended_at before enabling.
  // Events without ended_at are still ongoing — button stays disabled.
  const CLIP_READY_MS  = 70 * 1000;
  const endedAtMs      = ev.ended_at ? new Date(ev.ended_at).getTime() : NaN;
  const clipReady      = !isNaN(endedAtMs) && (Date.now() - endedAtMs) > CLIP_READY_MS;
  const clipBtn = clipReady
    ? `<button class="btn-clip" onclick="openClipViewer('${ev.timestamp}', '${ev.ended_at}', '${ev.type || ''}')">▶ Ver Clipe</button>`
    : `<button class="btn-clip" disabled title="Disponível quando a gravação do ciclo terminar">⏳ Processando…</button>`;

  const snapshotBtn = ev.snapshot_path
    ? `<button class="btn-clip btn-snapshot" onclick="openSnapshotViewer('${ev.id}')">🖼 Ver Snapshot</button>`
    : '';

  item.innerHTML = `
    ${thumbHtml}
    <div class="event-info">
      <div class="event-type ${typeClass}">${typeLabel}</div>
      <div class="event-ts">${formatTs(ev.timestamp)}</div>
      ${confHtml}
      ${durHtml}
      ${clipBtn}
      ${snapshotBtn}
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
  const type  = document.getElementById('filter-type').value;

  let url = '/events?';
  if (start) url += `startTime=${encodeURIComponent(new Date(start).toISOString())}&`;
  if (end)   url += `endTime=${encodeURIComponent(new Date(end).toISOString())}&`;
  if (type)  url += `type=${encodeURIComponent(type)}&`;

  let events;
  try {
    const r = await authFetch(url);
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
  document.getElementById('filter-type').value  = '';
  loadEvents();
}

// ── Connectivity history ──────────────────────────────────────
async function loadConnectivity() {
  let data;
  try {
    const r = await authFetch('/status');
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
const CLIP_PADDING_MS = 10 * 1000; // default preroll for manual and human clips
let _clipObjectUrl = null;

async function openClipViewer(timestamp, endedAt, eventType = '') {
  const eventStart = new Date(timestamp);
  const eventEnd   = endedAt ? new Date(endedAt) : eventStart;
  const preRollMs  = eventType === 'motion_detected'
    ? (currentSettings?.motion?.preRollSeconds || 10) * 1000
    : CLIP_PADDING_MS;
  const postRollMs = eventType === 'motion_detected' ? 0 : CLIP_PADDING_MS;
  const start = new Date(eventStart.getTime() - preRollMs);
  const end   = new Date(eventEnd.getTime()   + postRollMs);
  const url   = withAccessToken(`/clip?startTime=${encodeURIComponent(start.toISOString())}&endTime=${encodeURIComponent(end.toISOString())}`);

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
    const res = await authFetch(url);
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

// ── Snapshot viewer ───────────────────────────────────────────
function openSnapshotViewer(eventId) {
  const overlay  = document.getElementById('snapshot-modal-overlay');
  const img      = document.getElementById('snapshot-modal-img');
  const title    = document.getElementById('snapshot-modal-title');
  const download = document.getElementById('snapshot-modal-download');

  const url = withAccessToken(`/snapshots/event-${eventId}.jpg`);
  title.textContent = `Snapshot — evento #${eventId}`;
  img.src = url;
  download.href     = url;
  download.download = `snapshot-event-${eventId}.jpg`;
  overlay.classList.add('open');
}

function closeSnapshotViewer() {
  const img = document.getElementById('snapshot-modal-img');
  img.src = '';
  document.getElementById('snapshot-modal-overlay').classList.remove('open');
}

// ── Clip link generator ───────────────────────────────────────
function buildClipLink() {
  const start = document.getElementById('clip-start').value;
  const end   = document.getElementById('clip-end').value;
  if (!start || !end) { alert('Selecione data/hora de início e fim.'); return; }
  const url  = withAccessToken(`/clip?startTime=${encodeURIComponent(new Date(start).toISOString())}&endTime=${encodeURIComponent(new Date(end).toISOString())}`);
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
    const r = await authFetch('/api/storage-usage');
    renderStorageUsage(await r.json());
  } catch {}
}

async function refreshStorageUsage() {
  document.getElementById('storage-total').textContent = '…';
  document.getElementById('storage-ts').textContent = '';
  try {
    const r = await authFetch('/api/storage-usage/refresh', { method: 'POST' });
    renderStorageUsage(await r.json());
  } catch {}
}

// ── Cleanup modal ─────────────────────────────────────
function openCleanupModal() {
  document.getElementById('cleanup-result').style.display = 'none';
  document.getElementById('cleanup-confirm-btn').disabled = false;
  document.getElementById('cleanup-confirm-btn').textContent = 'Confirmar limpeza';
  // Fetch current retention config from /status to display in warning text
  authFetch('/status').then(r => r.json()).then(data => {
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
    const r = await authFetch('/api/cleanup/run', { method: 'POST' });
    const { removedBytes, filesCount } = await r.json();
    resultEl.style.display = 'block';
    resultEl.style.color = 'var(--green)';
    resultEl.textContent =
      `✅ Limpeza concluída: ${filesCount} arquivo(s) removido(s) (${formatBytes(removedBytes)}). Recarregando…`;
    // Refresh storage badge then reload to clear events/history lists
    fetchStorageUsage();
    btn.textContent = 'Concluído';
    setTimeout(() => location.reload(), 1500);
  } catch {
    resultEl.style.display = 'block';
    resultEl.style.color = 'var(--red)';
    resultEl.textContent = '❌ Erro ao executar limpeza. Verifique os logs.';
    btn.disabled = false;
    btn.textContent = 'Confirmar limpeza';
  }
}

// ── Init ──────────────────────────────────────────────────────
async function initApp() {
  bindAuthUi();
  updateProtectedLinks();

  const allowed = await ensureAccessToken();
  if (!allowed) return;

  connectWs();
  refreshProtectedData();
  startPolling();
}

initApp().catch((err) => {
  console.error('[UI] Failed to initialize app:', err.message);
});
