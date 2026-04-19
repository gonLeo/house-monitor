# House Monitor

Turn an old webcam into an effective home security system — no subscriptions, no cloud, no monthly fees.

House Monitor runs entirely on your local machine. It streams live video from any DirectShow webcam, detects people using an on-device AI model (COCO-SSD / TensorFlow.js), records continuous H.264 video segments, saves event snapshots, and displays everything in a browser dashboard. All data stays on your machine and recording continues even when your internet goes down.

---

## Features

- **Live stream** — real-time MJPEG stream in the browser via WebSocket
- **Person detection** — on-device AI inference, no cloud API required
- **Continuous recording** — H.264 video segments written to disk at all times
- **Snapshot on detection** — saves a JPEG for every person-detected event
- **Clip generation** — export any time range as an MP4 directly from the browser
- **Audio recording** — optional microphone capture synced to video clips
- **Push notifications** — optional alerts via [ntfy.sh](https://ntfy.sh) on person detection
- **Offline-first** — connectivity monitor tracks outages; recording never stops
- **Auto cleanup** — old segments, audio, and logs are deleted automatically (configurable retention)

---

## Requirements

| Tool | Min version | Notes |
|---|---|---|
| [Node.js](https://nodejs.org) | 18.x | |
| [Docker Desktop](https://www.docker.com/products/docker-desktop) | 24.x | Runs PostgreSQL |
| [FFmpeg](https://ffmpeg.org/download.html) | 6.x | See install note below |

### Installing FFmpeg on Windows

1. Download the **full build** (static) from [ffmpeg.org/download.html](https://ffmpeg.org/download.html) — choose the Windows build from *gyan.dev* or *BtbN*.
2. Extract the zip and add the `bin/` folder to your system **PATH**:
   - Search *"Edit the system environment variables"* → Environment Variables → Path → New → paste the path to `bin/`.
3. Open a new terminal and verify:
   ```powershell
   ffmpeg -version
   ```

---

## Setup

### 1. Find your webcam name

```powershell
ffmpeg -list_devices true -f dshow -i dummy 2>&1
```

Look for a line like `"Integrated Webcam" (video)` and copy the exact device name.

### 2. Configure environment

```powershell
copy .env.example .env
```

Open `.env` and set at minimum:

```env
CAMERA_DEVICE=Your Webcam Name    # exact name from step 1
AUDIO_DEVICE=Microphone (...)     # exact name from step 1, or leave empty
```

All other values have sensible defaults. Change `DB_PASSWORD` from the default if you want extra hardening on the local Postgres instance.

### 3. Start the database

```powershell
docker compose up -d
```

Wait until Docker reports the container as `(healthy)`:

```powershell
docker ps
```

### 4. Install dependencies

```powershell
npm install
```

> TensorFlow.js + COCO-SSD are ~150 MB. The COCO-SSD model weights (~10 MB) are downloaded on first run.

### 5. Start the app

```powershell
npm start
```

Open **http://localhost:3000** in your browser.

### 6. Remote access with Cloudflare Tunnel

If you want to access the dashboard from outside your local network, you can publish the local app securely through a Cloudflare Tunnel.

#### Option A — quick temporary tunnel

This gives you a random public URL under `trycloudflare.com`:

```powershell
docker run --rm cloudflare/cloudflared:latest tunnel --url http://host.docker.internal:3000
```

If your app is running on port `8080`, replace `3000` with `8080`.

#### Option B — permanent tunnel with your own domain

1. In Cloudflare Zero Trust, create a **Named Tunnel**.
2. Add a **Public Hostname** such as `monitor.yourdomain.com`.
3. Set the service type to **HTTP** and the URL to:
   - `http://host.docker.internal:3000`, or
   - `http://host.docker.internal:8080` if you changed the app port.
4. Copy the generated tunnel token into your `.env` file:

```env
CLOUDFLARE_TUNNEL_TOKEN=your_tunnel_token_here
```

5. Start the tunnel container:

```powershell
docker compose --profile remote up -d cloudflared
```

Once started, open your public hostname in the browser.

> The live preview already uses the current page host/protocol for WebSocket streaming, so it also works through HTTPS/WSS behind Cloudflare.

---

## How it works

```
Webcam (DirectShow)
  └─► FFmpeg MJPEG stream
        └─► Frame parser (JPEG boundaries)
              ├─► WebSocket → Browser live view
              ├─► Video encoder → H.264 segments (segments/YYYY-MM-DD/)
              ├─► Audio recorder → m4a segments (audio/YYYY-MM-DD/)
              └─► Worker Thread: COCO-SSD inference
                    └─► Person detected?
                          ├─► Save snapshot (snapshots/)
                          ├─► Insert event → PostgreSQL
                          ├─► Push notification (ntfy.sh, optional)
                          └─► Alert in browser
```

- Detection runs in a dedicated worker thread — inference never blocks the stream.
- A presence tracker groups detections into sessions; a new event is created after `ABSENCE_THRESHOLD_SECONDS` of no detections.
- Every `RETENTION_HOURS` hours the cleanup job runs and wipes all segments, audio, logs, and snapshots.

---

## Configuration (`.env`)

| Variable | Default | Description |
|---|---|---|
| `CAMERA_DEVICE` | `Integrated Webcam` | DirectShow video device name |
| `CAMERA_WIDTH/HEIGHT` | `1280` / `720` | Capture resolution |
| `CAMERA_FPS` | `30` | Capture framerate |
| `AUDIO_DEVICE` | *(empty)* | DirectShow audio device — leave empty to disable |
| `ABSENCE_THRESHOLD_SECONDS` | `60` | Seconds of no detection before presence session ends |
| `SEGMENTS_DIR` | `./segments` | Where H.264 video segments are stored |
| `SEGMENT_DURATION_SECONDS` | `60` | Duration of each video segment file |
| `SEGMENT_FPS` | `15` | FPS written into segment files |
| `RETENTION_HOURS` | `12` | Interval in hours between full cleanup runs (deletes all media) |
| `NTFY_TOPIC` | *(empty)* | [ntfy.sh](https://ntfy.sh) topic for push notifications |
| `PORT` | `3000` | HTTP server port |
| `DB_PASSWORD` | `monitor123` | PostgreSQL password (local only) |

---

## API

| Endpoint | Description |
|---|---|
| `GET /events` | List detection events (`startTime`, `endTime`, `type` filters) |
| `GET /snapshot/:id` | JPEG snapshot for an event |
| `GET /clip?startTime=&endTime=` | Generate and download an MP4 clip |
| `GET /status` | Camera, connectivity, uptime, last event |
| `GET /api/alarm` | Get alarm enabled state |
| `POST /api/alarm` | Toggle alarm `{ "enabled": true }` |

---

## Stopping

```powershell
# Stop Node.js: Ctrl+C

# Stop and remove database container
docker compose down

# Also delete all database data
docker compose down -v
```

---

## Troubleshooting

| Problem | Likely cause | Fix |
|---|---|---|
| `Could not connect to PostgreSQL` | Docker not running | `docker compose up -d` |
| `Failed to start ffmpeg` | FFmpeg not in PATH | Reinstall FFmpeg, restart terminal |
| `dshow: Could not find video device` | Wrong device name | Re-run the `ffmpeg -list_devices` command |
| Stream slow / low FPS | High CPU from inference | Increase `DETECTION_SKIP` in `src/capture/pipeline.js` |
| COCO-SSD fails to load | No internet on first run | Connect to internet and restart |

---

## License

MIT
