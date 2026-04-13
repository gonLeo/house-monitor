# House Monitor MVP

Sistema de videomonitoramento local resiliente com detecção de humanos por IA, operação offline-first e armazenamento em PostgreSQL + disco.

---

## Arquitetura

```
┌─────────────────────────────────────────────────────┐
│                  Node.js (host)                     │
│                                                     │
│  FFmpeg (dshow) → CameraCapture → Pipeline          │
│                       │                             │
│              ┌────────┼────────────┐                │
│              ▼        ▼            ▼                │
│         WebSocket  Detector    Storage (disco)      │
│         (stream)  (COCO-SSD)   frames/ snapshots/   │
│              │        │                             │
│              │        └─► DB Queries ──► PostgreSQL │
│              │                    (Docker)          │
│              ▼                                      │
│         Browser SPA  ◄──► REST API (Express)        │
└─────────────────────────────────────────────────────┘
```

- **Captura**: FFmpeg DirectShow → MJPEG → parser de boundaries JPEG
- **Detecção**: TF.js (CPU, puro-JS) + COCO-SSD `lite_mobilenet_v2`
- **Persistência**: PostgreSQL 15 (Docker) + JPEGs em disco
- **Conectividade**: `dns.resolve('google.com')` a cada 5 min
- **Frontend**: HTML vanilla, WebSocket para stream ao vivo

---

## Pré-requisitos

| Ferramenta | Versão mínima | Como instalar |
|---|---|---|
| Node.js | 18.x | https://nodejs.org |
| Docker Desktop | 24.x | https://docker.com/products/docker-desktop |
| FFmpeg | 6.x | https://ffmpeg.org/download.html |

> **FFmpeg no Windows**: Baixe o build estático, extraia e adicione a pasta `bin/` ao PATH do sistema.
> Verifique com: `ffmpeg -version`

---

## Instalação e uso

### 1 — Descobrir o nome da sua webcam

Abra um terminal e execute:

```powershell
ffmpeg -list_devices true -f dshow -i dummy 2>&1
```

Você verá algo como:
```
[dshow @ ...] "Integrated Webcam" (video)
[dshow @ ...] "USB2.0 HD UVC WebCam" (video)
```

Copie o nome exato (incluindo maiúsculas/minúsculas).

### 2 — Configurar variáveis de ambiente

```powershell
copy .env.example .env
```

Abra `.env` e ajuste:

```env
CAMERA_DEVICE=Integrated Webcam   # ← Cole o nome exacto aqui
CAMERA_FPS=10
COOLDOWN_SECONDS=30
PORT=3000
```

### 3 — Iniciar o banco de dados

```powershell
docker compose up -d
```

Aguarde o healthcheck passar:

```powershell
docker ps
# STATUS deve mostrar "(healthy)"
```

### 4 — Instalar dependências Node.js

```powershell
npm install
```

> **Nota**: `@tensorflow/tfjs` + `@tensorflow-models/coco-ssd` somam ~150 MB.

### 5 — Iniciar a aplicação

```powershell
npm start
```

Na primeira execução, o modelo COCO-SSD (~10 MB) é baixado da CDN do Google.

Resultado esperado:
```
╔══════════════════════════════════╗
║        House Monitor MVP         ║
╚══════════════════════════════════╝
[DB] Connection established.
[DB] Migrations applied successfully.
[App] Loading COCO-SSD model…
[Detector] TF.js backend: cpu
[Detector] COCO-SSD model loaded.
[App] ✓ Server running  →  http://localhost:3000
[Camera] Starting capture: device="Integrated Webcam" 640x480 @ 10fps
[Connectivity] Monitor started (interval: 5 min).
[Pipeline] Started.
```

### 6 — Acessar o frontend

Abra: **http://localhost:3000**

---

## Interface Web

| Seção | Descrição |
|---|---|
| **Ao Vivo** | Stream da câmera com FPS e status de conexão |
| **Eventos** | Lista com thumbnail, timestamp e confiança. Filtrável por data |
| **Gerar Clipe** | Selecione intervalo e baixe um MP4 com os frames do período |
| **Histórico de Conectividade** | Log de quedas/restabelecimentos de internet |

---

## API REST

| Endpoint | Descrição |
|---|---|
| `GET /events` | Lista eventos. Params: `startTime`, `endTime`, `synced`, `type` |
| `GET /snapshot/:id` | Retorna o JPEG de uma detecção |
| `GET /clip?startTime=&endTime=` | Gera e faz download de clipe MP4 |
| `GET /status` | Status atual: câmera, conectividade, uptime, histórico |

Exemplos:

```bash
# Todos os eventos da última hora
curl "http://localhost:3000/events?startTime=2026-01-01T12:00:00Z"

# Status do sistema
curl "http://localhost:3000/status"

# Clipe de 10 minutos
curl -o clip.mp4 "http://localhost:3000/clip?startTime=2026-01-01T12:00:00Z&endTime=2026-01-01T12:10:00Z"
```

---

## Testando a resiliência offline

1. Com o sistema rodando, verifique que o status no frontend mostra **online**.

2. **Simule queda de internet** no Windows:
   - Acesse **Configurações → Rede → Wi-Fi (ou Ethernet)** e desative o adaptador.
   - Ou execute: `netsh interface set interface "Wi-Fi" disable`

3. Aguarde até **5 minutos** (intervalo do monitor de conectividade).

4. O console mostrará:
   ```
   [Connectivity] Status changed: online → offline
   [Connectivity] Internet connection lost. Events will continue to be recorded locally.
   ```

5. Posicione alguém na frente da câmera — os eventos continuam sendo salvos normalmente no PostgreSQL.

6. **Restabeleça a conexão**:
   - `netsh interface set interface "Wi-Fi" enable`

7. No próximo ciclo de verificação (até 5 min), o console exibirá:
   ```
   [Connectivity] ✓ Connection restored!
     Offline period : 2026-01-01T12:05:00.000Z → 2026-01-01T12:47:00.000Z
     Duration       : ~42 minute(s)
     Events recorded: 3
   ```
   Um evento `connection_restored` também é gravado no banco.

---

## Estrutura de diretórios

```
house-monitor/
├── docker-compose.yml       # PostgreSQL 15 (único serviço Docker)
├── .env.example             # Template de configuração
├── .gitignore
├── package.json
├── README.md
├── sql/
│   └── schema.sql           # CREATE TABLE events, connectivity_log
├── src/
│   ├── index.js             # Entry point
│   ├── config.js            # dotenv + valores padrão
│   ├── db/
│   │   ├── connection.js    # pg.Pool + retry de conexão
│   │   ├── migrations.js    # Aplica schema.sql no startup
│   │   └── queries.js       # Todas as operações de DB
│   ├── capture/
│   │   ├── camera.js        # FFmpeg dshow + parser MJPEG
│   │   └── pipeline.js      # Orquestra frame→detect→stream→save
│   ├── detection/
│   │   ├── detector.js      # TF.js + COCO-SSD (CPU backend)
│   │   └── cooldown.js      # Anti-spam 30s
│   ├── streaming/
│   │   └── wsServer.js      # WebSocket server + FPS counter
│   ├── connectivity/
│   │   └── monitor.js       # Check DNS a cada 5min
│   ├── storage/
│   │   ├── files.js         # saveFrame(), saveSnapshot(), getFramesInRange()
│   │   └── cleanup.js       # Cron: apaga frames > 48h
│   ├── api/
│   │   ├── server.js        # Express setup
│   │   ├── routes.js        # Rotas REST
│   │   └── clips.js         # FFmpeg concat → MP4
│   └── public/
│       └── index.html       # SPA (HTML + JS vanilla)
├── frames/                  # Criado em runtime — frames contínuos
└── snapshots/               # Criado em runtime — snapshots de detecções
```

---

## Configurações avançadas

### Aumentar sensibilidade de detecção

Edite `src/capture/pipeline.js`:
```js
const MIN_CONFIDENCE = 0.4; // padrão: 0.5 (50%)
```

### Alterar resolução ou FPS

No `.env`:
```env
CAMERA_WIDTH=1280
CAMERA_HEIGHT=720
CAMERA_FPS=15
```

> Resoluções maiores aumentam o uso de CPU para detecção e mais espaço em disco.

### Espaço em disco

A taxa de gravação é aproximadamente:

```
640×480 @ 10fps ≈ 20 KB/frame × 10 fps = 200 KB/s = ~17 GB/dia
```

Ajuste `FRAME_RETENTION_HOURS` conforme o espaço disponível. A limpeza automática roda a cada hora.

---

## Parando tudo

```powershell
# Aplicação Node.js: Ctrl+C no terminal

# Banco de dados
docker compose down

# Remover dados do banco (irreversível)
docker compose down -v
```

---

## Solução de problemas

| Problema | Causa provável | Solução |
|---|---|---|
| `Could not connect to PostgreSQL` | Docker não iniciado | `docker compose up -d` |
| `Failed to start ffmpeg` | FFmpeg não está no PATH | Instalar FFmpeg e reiniciar o terminal |
| `dshow: Could not find video device` | Nome errado em `CAMERA_DEVICE` | Reexecutar `ffmpeg -list_devices true -f dshow -i dummy 2>&1` |
| Stream lento / FPS baixo | Detecção consumindo CPU | Aumentar `DETECTION_SKIP` em `pipeline.js` |
| Modelo COCO-SSD não carrega | Sem internet na primeira execução | Conectar à internet e reiniciar |
