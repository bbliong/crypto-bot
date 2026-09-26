# Panduan Menjalankan Automated Trading & Dashboard di Server VPS

Panduan lengkap untuk menjalankan **Automated Buy/Sell Bot (`browser:buy:auto`)** dan **Web Dashboard (`dashboard:serve`)** pada VPS Linux (Ubuntu / Debian x86_64).

---

## 1. Arsitektur & Komponen

1. **Virtual Display (`Xvfb :99`)**: Menyediakan layar virtual agar Google Chrome dapat berjalan secara *headed* di VPS tanpa monitor fisik.
2. **Automated Trading Bot (`browser:buy:auto`)**:
   - Membaca feed WebSocket GMGN realtime.
   - Mengevaluasi filter & strategi Momentum V2.
   - Mengeksekusi Buy & Sell langsung via API GMGN (`/mrtapi/v2/swap_batch_order`) dari konteks browser tab tanpa modal konfirmasi.
   - Menghasilkan laporan komparasi data Sinyal Simulasi vs Data Riil Walletstat API.
3. **Web Dashboard (`dashboard:serve`)**: Server HTTP internal (port 4173) untuk menampilkan laporan komparasi, riwayat run, dan data socket token secara realtime.
4. **SSH Tunneling**: Membuka dashboard di browser PC/laptop Anda dengan aman tanpa membuka port firewall ke publik.

---

## 2. Persiapan Awal di VPS

### A. Install Paket Sistem & Google Chrome
Masuk ke VPS via SSH, lalu jalankan:

```bash
sudo apt-get update && sudo apt-get install -y git xvfb xauth curl tmux

# Install Node.js 22.x (jika belum terpasang)
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs

# Verifikasi Node.js (minimal v22.13.0)
node -v
```

### B. Clone Proyek & Pasang Browser Chrome
```bash
# Clone atau masuk ke direktori bot
git clone -b momentum-v2 https://github.com/bbliong/crypto-bot.git /home/crypto/crypto-bot
cd /home/crypto/crypto-bot

# Install dependencies Node
npm ci

# Install Google Chrome asli dan library sistemnya via Playwright
npx playwright install --with-deps chrome

# Buat folder profil dan research
mkdir -p profiles/research-vps research dist
```

### C. Login Akun & Wallet GMGN di Profil VPS
Profil Chrome di VPS harus memiliki sesi login GMGN dan wallet Solana yang aktif.

Jalankan perintah ini sekali untuk membuka browser pada display virtual:
```bash
# Jalankan Xvfb sementara
Xvfb :99 -screen 0 1600x900x24 -nolisten tcp &

# Buka Chrome untuk login (bisa diakses via VNC / x11vnc)
DISPLAY=:99 google-chrome \
  --user-data-dir=/home/crypto/crypto-bot/profiles/research-vps \
  --profile-directory=Default \
  'https://gmgn.ai/?chain=sol'
```
*Pastikan wallet GMGN sudah terhubung dan ada saldo SOL untuk gas fee + modal swap (misal $0.25).* Setelah selesai login, tutup Chrome.

---

## 3. Menjalankan Manual dengan `tmux` (Rekomendasi untuk Testing)

Gunakan `tmux` agar proses tetap berjalan meskipun koneksi SSH Anda terputus.

### Langkah 1: Buka Sesi Tmux
```bash
tmux new -s gmgn
```

### Langkah 2: Jalankan Virtual Display Xvfb
```bash
# Jalankan Xvfb di background display :99
Xvfb :99 -screen 0 1600x900x24 -nolisten tcp &
export DISPLAY=:99
```

### Langkah 3: Jalankan Web Dashboard (Pane 1)
```bash
cd /home/crypto/crypto-bot
npm run dashboard:serve
```
*Dashboard akan aktif di `http://127.0.0.1:4173`.*

### Langkah 4: Buka Window/Pane Baru untuk Bot Trading
Tekan `Ctrl+B` lalu `C` (membuat window tmux baru), kemudian pilih salah satu mode:

#### Pilihan A: Test 1 Transaksi Saja (Auto Buy & Sell 1x Lalu Berhenti)
Cocok untuk memastikan order live berhasil dan laporan terbentuk:
```bash
cd /home/crypto/crypto-bot
DISPLAY=:99 npm run browser:buy:auto -- --maxBuys 1 --profileDir profiles/research-vps --profileName Default
```

#### Pilihan B: Jalan Kontinu Tanpa Batas (3 Worker Standar)
```bash
cd /home/crypto/crypto-bot
DISPLAY=:99 npm run browser:buy:auto -- --profileDir profiles/research-vps --profileName Default
```

#### Pilihan C: Mode Hemat RAM VPS (1 Worker Saja)
Sangat dianjurkan jika VPS Anda hanya memiliki RAM 1 GB – 2 GB:
```bash
cd /home/crypto/crypto-bot
DISPLAY=:99 npm run browser:buy:auto -- --workers 1 --profileDir profiles/research-vps --profileName Default
```

Untuk keluar dari tmux tanpa mematikan bot: tekan `Ctrl+B` lalu `D` (*detach*).  
Untuk kembali masuk ke tmux: `tmux attach -t gmgn`.

---

## 4. Menjalankan Otomatis di Background (Systemd Service)

Untuk penggunaan jangka panjang (24/7), buat 3 service systemd agar bot dan dashboard otomatis hidup saat VPS reboot.

### A. Service Display Xvfb (`/etc/systemd/system/gmgn-display.service`)
```ini
[Unit]
Description=Virtual display for GMGN Chrome
After=network.target

[Service]
User=crypto
ExecStart=/usr/bin/Xvfb :99 -screen 0 1600x900x24 -nolisten tcp
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

### B. Service Web Dashboard (`/etc/systemd/system/gmgn-dashboard.service`)
```ini
[Unit]
Description=GMGN Dashboard on port 4173
After=network.target

[Service]
Type=simple
User=crypto
WorkingDirectory=/home/crypto/crypto-bot
Environment=HOME=/home/crypto
ExecStart=/usr/bin/npm run dashboard:serve
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

### C. Service Automated Trading (`/etc/systemd/system/gmgn-autotrade.service`)
```ini
[Unit]
Description=GMGN Automated Momentum V2 Trading Bot
Requires=gmgn-display.service
After=network-online.target gmgn-display.service
Wants=network-online.target

[Service]
Type=simple
User=crypto
WorkingDirectory=/home/crypto/crypto-bot
Environment=HOME=/home/crypto
Environment=DISPLAY=:99
# Jalankan bot otomatis secara kontinu:
ExecStart=/usr/bin/npm run browser:buy:auto -- --seconds 0 --workers 3 --stakeUsd 0.25 --profileDir profiles/research-vps --profileName Default
Restart=on-failure
RestartSec=10
TimeoutStopSec=30

[Install]
WantedBy=multi-user.target
```

### D. Mengaktifkan dan Mengelola Service
```bash
# Reload daemon
sudo systemctl daemon-reload

# Aktifkan dan jalankan semua service
sudo systemctl enable --now gmgn-display gmgn-dashboard gmgn-autotrade

# Periksa status
sudo systemctl status gmgn-autotrade gmgn-dashboard

# Melihat log bot trading secara realtime:
journalctl -u gmgn-autotrade -f

# Menghentikan bot:
sudo systemctl stop gmgn-autotrade
```

---

## 5. Cara Melihat Dashboard & Laporan dari PC/Laptop

Server dashboard sengaja di-bind ke `127.0.0.1` demi keamanan. Anda tidak perlu membuka port di firewall VPS. Cukup gunakan **SSH Tunneling**:

### Langkah 1: Buat SSH Tunnel di Terminal PC/Laptop Anda
Buka PowerShell atau Terminal di komputer Anda, lalu jalankan:

```bash
ssh -N -L 4173:127.0.0.1:4173 user@IP_VPS_ANDA
```
*(Biarkan terminal ini tetap terbuka).*

### Langkah 2: Buka di Browser PC/Laptop
Buka browser (Chrome / Edge / Brave), lalu akses:

- **Laporan Run Aktif / Terbaru:**  
  👉 **`http://127.0.0.1:4173/paper-simulation-report.html`**
- **Riwayat Semua Run:**  
  👉 **`http://127.0.0.1:4173/run-history.html`**

Laporan akan me-refresh data otomatis setiap 10 detik dan menampilkan:
1. **Data Sinyal Simulasi:** Entry price, exit price, P/L sinyal ($ & %).
2. **Data Riil API / Wallet GMGN:** Cost beli, income jual, harga rata-rata riil, Tx Solscan, dan gross P/L nyata.
3. **Selisih Riil vs Sinyal:** Slippage harga entry dan delta P/L.

---

## 6. Tips Perawatan & Update Kode

Saat ada pembaruan kode di GitHub:
```bash
# 1. Hentikan service
sudo systemctl stop gmgn-autotrade

# 2. Pull perubahan terbaru
cd /home/crypto/crypto-bot
git pull origin momentum-v2
npm ci
npm run typecheck

# 3. Jalankan kembali service
sudo systemctl start gmgn-autotrade
```
*(Folder `profiles/` dan `research/` akan tetap aman dan tidak akan tertimpa saat `git pull`).*
