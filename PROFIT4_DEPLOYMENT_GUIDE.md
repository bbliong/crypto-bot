# Panduan Deployment & Operasional Profit4 Bot (Server Baru)

> **Dokumen untuk AI Agent / DevOps Engineer**: Panduan teknis lengkap langkah demi langkah untuk melakukan deploy, konfigurasi, dan pemeliharaan sistem **Profit4 & Multi-Lane Bounce Trading Bot** di server Linux baru (Ubuntu/Debian).

---

## 1. Ikhtisar Project Profit4

### 1.1 Apa itu Profit4?
**Profit4** adalah sistem algorithmic automated & paper trading Solana token yang memantau transfer token dari wallet-wallet target (*smart money / distribution wallets*), memvalidasi momentum likuiditas token melalui WebSocket GMGN, dan mengeksekusi order beli dan jual secara real-time.

Sistem terdiri dari:
1. **Multi-Lane Strategy Engine**:
   - **P4 (`DistributionProfit4Lane`)**: Target profit bersih 4% (fee model 1%/sisi + slippage 0.5% + fixed cost), stop loss 5%, holding maksimal 300 detik.
   - **V1 - V4 (`DistributionBounceLane`)**: Menangkap bounce setelah dump tajam (30-40% dump), staircase confirmation, dynamic profit targets (18-40%), dan whale sell protection.
   - **V5 (`DistributionBounceLaneV5`)**: Filter anti-rugpull ketat (cek sisa suplai dev balance, whale sell cooldown 45s, deteksi penurunan holder drastis).
2. **Real Auto-Buy Engine (`src/profit4-live-engine.ts`)**:
   - Swap Solana token melalui sesi browser GMGN tanpa menyimpan private key on-server.
   - Membaca saldo SOL real-time langsung via Solana RPC endpoint.
   - On-chain cashflow accounting: mencatat signature transaksi, SOL native & WSOL delta, serta network fee ke dalam `data/profit4-watch/real-trade-ledger.jsonl`.
3. **Web Dashboard (`scripts/serve-profit4-dashboard.mjs`)**:
   - Menjalankan HTTP server (Port default: `4178`).
   - Memiliki 4 Tab: **Ringkasan**, **Posisi Aktif**, **Riwayat Transaksi**, dan **On-Chain & Auto-Buy**.
   - Menyediakan live worker start/stop, wallet manager, real trade audit, manual take-profit/sell, dan rekonsiliasi order on-chain.

---

## 2. Kebutuhan Sistem Minimum

| Komponen | Spesifikasi Minimum | Rekomendasi |
| :--- | :--- | :--- |
| **OS** | Ubuntu 22.04 LTS x86_64 | Ubuntu 24.04 LTS x86_64 |
| **CPU** | 2 Core vCPU | 4 Core vCPU |
| **RAM** | 4 GB | 8 GB (Chrome headed butuh memori stabil) |
| **Storage** | 40 GB NVMe/SSD | 80 GB SSD |
| **Node.js** | `>= 22.13.0` (**Wajib**: menggunakan fitur built-in `node:sqlite`) | Node v22.14.0+ |
| **Browser** | Google Chrome asli (Headed mode) | Managed via Playwright |
| **Display** | Xvfb Virtual Framebuffer (`:99`) | `xvfb-x.service` |

---

## 3. Langkah-Langkah Deployment di Server Baru

Jika Anda adalah AI Agent yang mengeksekusi setup ini di server baru, ikuti urutan perintah di bawah ini secara presisi:

### Langkah 3.1: Persiapan User & Dependensi OS

Buat user non-root (contoh: `crypto` atau `bbliong`):
```bash
# Jalankan sebagai root:
sudo apt-get update && sudo apt-get upgrade -y
sudo apt-get install -y git curl wget jq build-essential xvfb xauth x11vnc procps caddy

# Buat user crypto jika belum ada (opsional):
# sudo adduser --gecos "" crypto
# sudo usermod -aG sudo crypto
```

Pastikan user memiliki izin `lingering` agar service systemd tetap berjalan saat logout:
```bash
sudo loginctl enable-linger $USER
```

### Langkah 3.2: Instalasi Node.js (>= 22.13.0)

Gunakan NodeSource repository resmi untuk Node.js 22:
```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs

# Verifikasi versi Node dan npm:
node -v   # Harus >= v22.13.0
npm -v
```

### Langkah 3.3: Clone Repository & Pasang Dependencies

```bash
# Clone repository
mkdir -p ~/project
cd ~/project
git clone git@github.com:bbliong/crypto-bot.git
cd crypto-bot

# Checkout branch yang digunakan
git checkout codex/profit4-paper-monitor

# Install dependencies Node.js
npm ci

# Install Playwright browser dependencies dan Google Chrome
npx playwright install --with-deps chrome
```

### Langkah 3.4: Buat Struktur Direktori Data & Profil

```bash
mkdir -p data/profit4-watch/live
mkdir -p profiles/research-vps
chmod 700 profiles/research-vps
```

### Langkah 3.5: Verifikasi Codebase

Pastikan type checking dan test suite berjalan tanpa error:
```bash
npm run typecheck
node --import tsx --test tests/distribution-bounce-lane.test.ts tests/distribution-profit4.test.ts tests/profit4-dashboard.test.mjs tests/profit4-gmgn-execution.test.ts tests/profit4-live-api.test.mjs tests/profit4-live.test.ts
```

---

## 4. Setup Google Chrome & Sesi GMGN (PENTING)

Bot ini menggunakan sesi browser Google Chrome aktif di GMGN.ai untuk melakukan transaksi trading tanpa menyimpan Solana private key.

### Mengapa butuh Headed Chrome & Xvfb?
GMGN.ai menggunakan proteksi Cloudflare dan WebSockets browser. Bot berjalan di dalam browser Chromium/Chrome headed yang terhubung ke display `:99` (Xvfb).

### Opsi Login Profil GMGN:

#### Opsi A: Copy Profil dari Server Lama (Paling Cepat & Direkomendasikan)
Jika Anda melakukan migrasi dari server sebelumnya:
```bash
# Di server baru, salin direktori profil research-vps:
rsync -avz user@old-server:~/project/crypto-bot/profiles/research-vps/ ~/project/crypto-bot/profiles/research-vps/
```

#### Opsi B: Login Baru via VNC (Jika Server Baru Tanpa Profil Sebelumnya)
1. Jalankan Xvfb dan x11vnc sementara:
   ```bash
   Xvfb :99 -screen 0 1440x900x24 -nolisten tcp &
   x11vnc -display :99 -nopw -listen 127.0.0.1 -xkb &
   ```
2. Dari komputer lokal Anda, buat SSH tunnel:
   ```bash
   ssh -L 5900:127.0.0.1:5900 user@IP_SERVER
   ```
3. Buka Google Chrome di server:
   ```bash
   DISPLAY=:99 google-chrome --user-data-dir=$HOME/project/crypto-bot/profiles/research-vps --profile-directory=Default 'https://gmgn.ai/?chain=sol' &
   ```
4. Buka VNC Viewer di komputer lokal ke `127.0.0.1:5900`, lakukan koneksi wallet Solana (Phantom/Solflare) dan login ke GMGN.
5. Tutup Google Chrome setelah sesi tersimpan.

---

## 5. Konfigurasi Systemd Services

Sistem menggunakan 3 service systemd tingkat user (`~/.config/systemd/user/`):

### 5.1 Service 1: Display Virtual Xvfb (`xvfb-x.service`)
Lokasi: `~/.config/systemd/user/xvfb-x.service`
```ini
[Unit]
Description=Private virtual X display for Chrome X profile
After=network.target

[Service]
ExecStart=/usr/bin/Xvfb :99 -screen 0 1440x900x24 -nolisten tcp -ac -noreset
Restart=always
RestartSec=2

[Install]
WantedBy=default.target
```

### 5.2 Service 2: Profit4 Dashboard Web (`crypto-bot-profit4-dashboard.service`)
Lokasi: `~/.config/systemd/user/crypto-bot-profit4-dashboard.service`
```ini
[Unit]
Description=Profit4 Paper Lane & Bounce Web Dashboard (Port 4178)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=%h/project/crypto-bot
Environment=HOME=%h
Environment=PATH=%h/.local/bin:/usr/local/bin:/usr/bin:/bin
Environment=PROFIT4_DASHBOARD_PORT=4178
Environment=PROFIT4_DASHBOARD_HOST=0.0.0.0
Environment=SOLANA_RPC_URL=https://api.mainnet-beta.solana.com
ExecStart=/usr/bin/node --import tsx %h/project/crypto-bot/scripts/serve-profit4-dashboard.mjs
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
```

*(Catatan: Ganti `SOLANA_RPC_URL` dengan endpoint RPC kustom seperti Helius atau QuickNode jika tersedia untuk latency lebih cepat).*

### 5.3 Service 3: Profit4 Worker Watcher (`crypto-bot-bounce-worker.service`)
Lokasi: `~/.config/systemd/user/crypto-bot-bounce-worker.service`
```ini
[Unit]
Description=Crypto Bot Bounce Dump 30-40% Paper & Live Lane Worker
After=network-online.target xvfb-x.service
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=%h/project/crypto-bot
Environment=HOME=%h
Environment=DISPLAY=:99
Environment=PATH=%h/bin:%h/.local/bin:/usr/local/bin:/usr/bin:/bin
Environment=SOLANA_RPC_URL=https://api.mainnet-beta.solana.com
ExecStart=/usr/bin/node %h/project/crypto-bot/scripts/run-bounce-watch.mjs --pollMilliseconds 1200 --walletPollMilliseconds 6000
Restart=always
RestartSec=15
KillMode=mixed
TimeoutStopSec=30

[Install]
WantedBy=default.target
```

### 5.4 Mengaktifkan & Menjalankan Service

```bash
mkdir -p ~/.config/systemd/user
# (Simpan ketiga file service di atas ke folder tersebut)

systemctl --user daemon-reload

# Enable semua service
systemctl --user enable xvfb-x.service
systemctl --user enable crypto-bot-profit4-dashboard.service
systemctl --user enable crypto-bot-bounce-worker.service

# Jalankan service display dan dashboard
systemctl --user start xvfb-x.service
systemctl --user start crypto-bot-profit4-dashboard.service
systemctl --user start crypto-bot-bounce-worker.service
```

---

## 6. Konfigurasi Caddy (Reverse Proxy & SSL Domain)

Jika server memiliki domain publik (misalnya `cr.domain.com`), tambahkan routing ke `/etc/caddy/Caddyfile`:

```caddy
cr.domain.com {
    handle /profit4* {
        reverse_proxy 127.0.0.1:4178
    }

    # Fallback dashboard utama jika ada
    handle {
        reverse_proxy 127.0.0.1:4178
    }
}
```

Reload Caddy:
```bash
sudo systemctl reload caddy
```

Dashboard sekarang dapat diakses secara aman di `https://cr.domain.com/profit4`.

---

## 7. Konfigurasi File State & Parameter Bot

Semua pengaturan disimpan di `data/profit4-watch/`:

1. **`dashboard-config.json`**:
   Daftar wallet Solana yang dipantau (smart money transfer):
   ```json
   {
     "addresses": [
       "5bmpgSv6LHyfX6EQ9XnreapgW2VoaDJNAK8mRSNZGZoT",
       "3dKvjSVXCa2s5ysv5MGtjQ8CF4XZ6MKKTds2uGotXpwD",
       "2dVDVvzH4D3ihpUTbiG9yNSEsQBs8iFNRifcZP6TLqVK"
     ]
   }
   ```
2. **`autobuy-settings.json`**:
   Pengaturan eksekusi Real Auto-Buy:
   ```json
   {
     "enabled": false,
     "activeLane": "V4",
     "stakeMode": "usd",
     "stakeUsd": 0.5,
     "stakeSol": 0.003,
     "maxBuys": 3,
     "maxActiveRealPositions": 1,
     "buySlippagePercent": 9,
     "sellSlippagePercent": 14,
     "priorityFeeSol": 0.0001,
     "tipFeeSol": 0.0001,
     "minSolReserve": 0.025,
     "antiMev": false,
     "autoSell": true
   }
   ```
   > ⚠️ **Catatan Keamanan**: Setiap kali worker atau dashboard di-restart, status `enabled` secara otomatis diatur ke `false` demi keamanan modal pengguna. Pengguna dapat menyalakannya secara manual dari Web Dashboard tab *On-Chain & Auto-Buy*.

---

## 8. Verifikasi Operasional & Health Check

Untuk memastikan server baru berjalan sempurna:

1. **Cek Status Service**:
   ```bash
   systemctl --user status xvfb-x.service
   systemctl --user status crypto-bot-profit4-dashboard.service
   systemctl --user status crypto-bot-bounce-worker.service
   ```
2. **Cek Worker Log**:
   ```bash
   tail -f data/profit4-watch/worker.log
   ```
   *Tanda normal*: Terdapat polling transfer token, koneksi WebSocket GMGN established, dan evaluasi frame token.
3. **Cek Dashboard API**:
   ```bash
   curl -s http://127.0.0.1:4178/api/state | jq '.worker'
   curl -s http://127.0.0.1:4178/api/autobuy | jq '.readiness'
   ```
   *Tanda siap*: `sessionReady` bernilai `true`, `balanceSol` terdeteksi, dan `activeLanes` memuat `["V1", "V2", "V3", "V4", "V5"]`.

---

## 9. Troubleshooting & Pemeliharaan

| Masalah | Penyebab | Solusi |
| :--- | :--- | :--- |
| **HTTP 429 Too Many Requests** | GMGN membatasi rate request wallet activity | Worker sudah dilengkapi backoff otomatis 15 detik. Jaga `--pollMilliseconds` di `>= 1200ms` dan `--walletPollMilliseconds` di `>= 6000ms`. |
| **`sessionReady: false`** | Profil Chrome belum login ke GMGN atau cookies kedaluwarsa | Lakukan login ulang profil Chrome via VNC pada display `:99` ke https://gmgn.ai/?chain=sol. |
| **Saldo SOL tidak muncul** | RPC rate limit atau endpoint RPC down | Ganti `SOLANA_RPC_URL` di service systemd ke RPC berbayar (Helius/Quicknode). |
| **Disk penuh karena raw socket chunk** | Chunk 30 menit menumpuk di `data/profit4-watch/<run>/chunks/` | Jalankan script arsip: `bash scripts/auto-archive-chunks.sh` atau pasang cron job pembersihan chunk tua. |
| **Order status UNKNOWN di audit** | Jaringan Solana padat saat transaksi dikirim | Buka tab *On-Chain & Auto-Buy* -> klik *Detail* pada transaksi terkait -> masukkan signature transaksi untuk verifikasi on-chain langsung. |

---

## 10. Ringkasan Perintah Penting (Cheat Sheet AI)

```bash
# Cek semua status service crypto-bot:
systemctl --user status 'crypto-bot*'

# Restart dashboard:
systemctl --user restart crypto-bot-profit4-dashboard.service

# Restart worker:
systemctl --user restart crypto-bot-bounce-worker.service

# Lihat live log worker:
journalctl --user -u crypto-bot-bounce-worker.service -f

# Lihat log file langsung:
tail -n 100 -f data/profit4-watch/worker.log

# Run full tests:
npm run typecheck
npm test
```
