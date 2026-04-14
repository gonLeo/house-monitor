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
alarmToggle.addEventListener('change', () => {
  localStorage.setItem('alarmEnabled', alarmToggle.checked ? '1' : '0');
});
if (localStorage.getItem('alarmEnabled') === '0') alarmToggle.checked = false;

// ── Detection notification ────────────────────────────────────
let flashTimer = null;

function playAlarmTimes(remaining) {
  if (remaining <= 0) return;
  const a = new Audio('/alarm.mp3');
  a.play().catch(() => {});
  a.onended = () => playAlarmTimes(remaining - 1);
}

function handleDetection(event) {
  const flash = document.getElementById('detection-flash');
  flash.style.display = 'block';
  clearTimeout(flashTimer);
  flashTimer = setTimeout(() => { flash.style.display = 'none'; }, 4000);

  if (alarmToggle.checked) playAlarmTimes(2);

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

  const typeClass = ev.type === 'connection_restored' ? 'connection_restored' : '';

  item.innerHTML = `
    ${thumbHtml}
    <div class="event-info">
      <div class="event-type ${typeClass}">${ev.type.replace(/_/g, ' ')}</div>
      <div class="event-ts">${formatTs(ev.timestamp)}</div>
      ${confHtml}
      <button class="btn-clip" onclick="openClipViewer('${ev.timestamp}')">▶ Ver Clipe</button>
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
const CLIP_DURATION_MS = 2 * 60 * 1000; // 2 minutes from event
let _clipObjectUrl = null;

async function openClipViewer(timestamp) {
  const start = new Date(timestamp);
  const end   = new Date(start.getTime() + CLIP_DURATION_MS);
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

// ── Init ──────────────────────────────────────────────────────
connectWs();
loadEvents();
loadConnectivity();

setInterval(loadConnectivity, 30000);
setInterval(() => {
  const s = document.getElementById('filter-start').value;
  const e = document.getElementById('filter-end').value;
  if (!s && !e) loadEvents();
}, 30000);
