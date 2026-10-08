# Menjalankan Holder149 di server Ubuntu/Debian

Panduan ini hanya untuk monitor **read-only**: tidak menjalankan swap atau
transaksi Buy/Sell. Contoh memakai Ubuntu 24.04 x86-64, user `crypto`, direktori
`/home/crypto/crypto-bot`, dan branch `codex/holder149-monitor`.
Ganti user/path sesuai server Anda; panduan ini belum dieksekusi di VPS Anda.

## 1. Konfigurasi server

| Komponen | Konfigurasi contoh |
| --- | --- |
| Node.js | >=22.13.0, binary `/usr/bin/node` |
| Browser | Google Chrome, headed; bukan Chromium default |
| Display khusus | Xvfb `:98`, 1600x900x24 |
| Profil login Linux | `/home/crypto/crypto-bot/profiles/holder149-vps`, `Default` |
| Daftar holder | `config/holder149-wallets.json`, tepat 149 wallet unik |
| Batch / jeda | 3 wallet paralel / 3000ms, putaran sekitar 150 detik + respons |
| Detail / tab | Maksimal 3 mint unik + 1 tab controller |
| Dashboard | `127.0.0.1:4176`, akses melalui SSH tunnel |
| Capture | `data/holder149-watch/<run>/chunks/<UTC-30-min>/websocket-frames.jsonl` |
| Supervisor | systemd, worker dan dashboard sebagai service terpisah |

Untuk awal, sediakan misalnya 2 vCPU, 4 GiB RAM, dan disk 30 GiB atau lebih.
Ini anggaran awal, bukan hasil benchmark atau jaminan cukup. Pantau RAM Chrome,
CPU, dan pertumbuhan capture untuk menentukan kebutuhan sebenarnya.
Partisi 30 menit tidak mengurangi total ukuran dan belum ada retensi otomatis.

Google Chrome mode headed di Linux membutuhkan display virtual. Penyiapan
browser dan Xvfb mengikuti [dokumentasi browser Playwright](https://playwright.dev/docs/browsers)
dan [headed Linux Playwright](https://playwright.dev/docs/ci#running-headed).

## 2. Instalasi aplikasi

Jalankan aplikasi sebagai user biasa `crypto`, bukan root. User tersebut harus
sudah dibuat, memiliki home, dan mempunyai akses ke repo. Instal Node.js yang
memenuhi versi minimum dari sumber resmi/distribusi tepercaya, lalu periksa:

```bash
node --version
command -v node
command -v npm
sudo apt-get update
sudo apt-get install -y git xvfb xauth x11vnc procps
```

Sebagai user `crypto`:

```bash
git clone --branch codex/holder149-monitor --single-branch \
  https://github.com/bbliong/crypto-bot.git /home/crypto/crypto-bot
cd /home/crypto/crypto-bot
npm ci
npx playwright install --with-deps chrome
mkdir -p profiles/holder149-vps data/holder149-watch
chmod 700 profiles/holder149-vps
npm run typecheck
npm test
```

Instalasi dependensi OS/browser dapat meminta sudo. Chrome dipasang secara
global; cek dahulu bila server sudah mempunyai Chrome. Jangan mengganti versi
Playwright di `package-lock.json` hanya untuk deployment.

## 3. Display dan login GMGN sekali di Linux

Jangan menyalin cookie/profil Chrome Windows ke Linux. Buat login baru memakai
**user dan profil Linux yang sama** dengan service. Tidak perlu import profil
`buy-sell-watch` atau menjalankan `wallet:holder149-profile` di VPS baru.

Buat `/etc/systemd/system/holder149-display.service` sebagai admin:

```ini
[Unit]
Description=Dedicated virtual display for Holder149 Chrome
After=network.target

[Service]
Type=simple
User=crypto
ExecStart=/usr/bin/Xvfb :98 -screen 0 1600x900x24 -nolisten tcp
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now holder149-display.service
sudo systemctl status holder149-display.service
```

Pastikan `:98` tidak digunakan service lain. Display ini sengaja terpisah dari
contoh riset lama `:99`. Xvfb bukan desktop yang bisa langsung dilihat: untuk
login, gunakan VNC di display yang sama. Jalankan di terminal server sebagai
user `crypto`, dan biarkan terminalnya tetap terbuka:

```bash
x11vnc -display :98 -localhost -rfbport 5908 -forever -shared
```

VNC hanya bind localhost. Dari PC buat tunnel terpisah:

```powershell
ssh -N -L 5908:127.0.0.1:5908 crypto@IP_SERVER
```

Hubungkan VNC viewer ke `127.0.0.1:5908`. Pada terminal server lain sebagai
user `crypto`, buka Chrome:

```bash
DISPLAY=:98 google-chrome \
  --user-data-dir=/home/crypto/crypto-bot/profiles/holder149-vps \
  --profile-directory=Default 'https://gmgn.ai/?chain=sol'
```

Selesaikan login GMGN **secara manual** melalui viewer. Setelah itu tutup Chrome
secara normal dan hentikan x11vnc dengan Ctrl+C. Pertahankan Xvfb untuk worker.
Jangan buka login Chrome dan worker bersamaan pada profil yang sama.
Cookie mungkin kadaluarsa; ulangi prosedur login setelah menghentikan worker.
Profil berisi sesi login: jangan commit, upload publik, atau membagikan isinya.

## 4. Uji manual sebelum dijadikan service

Terminal worker, sebagai user `crypto`:

```bash
cd /home/crypto/crypto-bot
DISPLAY=:98 node scripts/run-holder149-watch.mjs \
  --walletsFile config/holder149-wallets.json \
  --dataDir data/holder149-watch \
  --profileDir profiles/holder149-vps \
  --profileName Default \
  --batchMilliseconds 3000
```

Terminal dashboard:

```bash
cd /home/crypto/crypto-bot
HOLDER149_MANAGE_WORKER=off HOLDER149_DASHBOARD_PORT=4176 \
  node scripts/serve-holder149-monitor-dashboard.mjs
```

Terminal PC, untuk akses dashboard:

```powershell
ssh -N -L 4176:127.0.0.1:4176 crypto@IP_SERVER
```

Buka `http://127.0.0.1:4176/`. Pastikan status `running`, daftar 149 wallet,
request berhasil bertambah, dan maksimal 3 detail. Nol detail bisa normal bila
aktivitas teratas bukan Buy. Respons aktivitas tidak disimpan; metadata status
dan manifest tetap ditulis. Periksa `lastError` jika request gagal/HTTP 429.

Hentikan kedua proses manual dengan Ctrl+C sebelum mengaktifkan service.
Jangan menjalankan worker kedua di profil/data root yang sama.

## 5. Service worker dan dashboard otomatis

Periksa `command -v node` dan sesuaikan semua `ExecStart` jika bukan
`/usr/bin/node`. systemd tidak otomatis membaca konfigurasi shell/NVM Anda.

`/etc/systemd/system/holder149-worker.service`:

```ini
[Unit]
Description=Holder149 read-only wallet and token socket monitor
Requires=holder149-display.service
After=network-online.target holder149-display.service
Wants=network-online.target

[Service]
Type=simple
User=crypto
WorkingDirectory=/home/crypto/crypto-bot
Environment=HOME=/home/crypto
Environment=DISPLAY=:98
ExecStart=/usr/bin/node /home/crypto/crypto-bot/scripts/run-holder149-watch.mjs --walletsFile config/holder149-wallets.json --dataDir data/holder149-watch --profileDir profiles/holder149-vps --profileName Default --batchMilliseconds 3000
Restart=always
RestartSec=15
KillMode=mixed
TimeoutStopSec=45
UMask=0077

[Install]
WantedBy=multi-user.target
```

`/etc/systemd/system/holder149-dashboard.service`:

```ini
[Unit]
Description=Holder149 monitoring dashboard on localhost
After=network.target

[Service]
Type=simple
User=crypto
WorkingDirectory=/home/crypto/crypto-bot
Environment=HOME=/home/crypto
Environment=HOLDER149_DASHBOARD_PORT=4176
Environment=HOLDER149_MANAGE_WORKER=off
ExecStart=/usr/bin/node /home/crypto/crypto-bot/scripts/serve-holder149-monitor-dashboard.mjs
Restart=always
RestartSec=5
TimeoutStopSec=15
UMask=0077

[Install]
WantedBy=multi-user.target
```

`HOLDER149_MANAGE_WORKER=off` membuat tombol/API Start/Stop read-only. systemd
satu-satunya supervisor worker, sehingga dashboard tidak meluncurkan child
kedua atau mencoba menghentikan worker yang kemudian di-restart systemd.
`KillMode=mixed` memberi proses Node kesempatan menutup browser lebih dahulu;
setelah timeout systemd menghentikan proses yang masih tertinggal di cgroup.

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now holder149-worker.service holder149-dashboard.service
sudo systemctl status holder149-worker.service holder149-dashboard.service
curl --fail http://127.0.0.1:4176/api/state
```

Jangan membuka port 4176/5908 ke internet. Dashboard tidak mempunyai autentikasi;
jika ingin URL publik, perlu reverse proxy HTTPS dan autentikasi terpisah.

## 6. Konfigurasi alternatif: worker dikelola dashboard

Hanya untuk penggunaan manual, tanpa service `holder149-worker` aktif:

```bash
cd /home/crypto/crypto-bot
DISPLAY=:98 \
HOLDER149_PROFILE_DIR=/home/crypto/crypto-bot/profiles/holder149-vps \
HOLDER149_PROFILE_NAME=Default \
HOLDER149_MANAGE_WORKER=on \
HOLDER149_DASHBOARD_PORT=4176 \
node scripts/serve-holder149-monitor-dashboard.mjs
```

Klik Mulai worker melalui SSH tunnel. `DISPLAY` diwarisi child worker. Ini
tidak otomatis memulai worker ketika dashboard/server restart; untuk 24/7
gunakan konfigurasi systemd pada bagian 5. Jangan mencampur kedua mode.

## 7. Operasi, update, dan masalah umum

```bash
journalctl -u holder149-worker.service -f
journalctl -u holder149-dashboard.service -f
sudo systemctl restart holder149-worker.service
sudo systemctl stop holder149-worker.service
du -sh /home/crypto/crypto-bot/data/holder149-watch
df -h /home/crypto/crypto-bot
```

Untuk update branch, hentikan worker/dashboard dahulu:

```bash
sudo systemctl stop holder149-worker.service holder149-dashboard.service
cd /home/crypto/crypto-bot
git status --short
git pull --ff-only origin codex/holder149-monitor
npm ci
npm run typecheck
npm test
sudo systemctl start holder149-worker.service holder149-dashboard.service
```

Lanjutkan start hanya bila pull/install/check berhasil. Jika ada perubahan
lokal, simpan terlebih dahulu; jangan gunakan reset hard. Jangan menghapus
`profiles/` atau `data/` saat update. Backup keduanya secara privat. Arsipkan
hanya partisi yang sudah selesai, bukan file socket yang masih aktif.

- **Missing X server / DISPLAY:** pastikan service display aktif dan `:98`
  sama pada login/worker. Xvfb saja tidak menampilkan login ke PC.
- **Chrome executable tidak ditemukan:** install Chrome sesuai Playwright,
  bukan hanya `npx playwright install chromium`.
- **Profil sumber buy-sell-watch tidak ditemukan:** profil default Windows
  mencoba import. Pada Linux gunakan profil `holder149-vps` dan `Default`
  seperti contoh di atas; jangan menjalankan helper salin profil Windows.
- **Chrome profile locked:** hentikan Chrome login/worker lain yang memakai
  profil tersebut. Jangan hapus lock atau memakai `--no-sandbox` sebagai fix.
- **HTTP 429:** worker sudah backoff global 15/30/60 detik. Bila sering terjadi,
  naikkan `--batchMilliseconds`, lalu restart service. Jangan bypass limit.
- **Login/activities tidak tersedia:** stop worker, login ulang pada profil
  Linux yang sama melalui VNC privat, tutup Chrome, lalu start worker.
- **Run baru setelah restart:** normal; dedup Buy ada di memori dan restart
  dapat membuka ulang Buy teratas lama. Capture sebelumnya tetap ada.
- **Stat ukuran file tertunda:** descriptor capture digunakan ulang. Untuk
  memastikan jumlah byte, baca file atau tunggu rotasi/penutupan; jangan
  menganggap ukuran metadata nol berarti socket tidak tersimpan.

Referensi supervisor: [systemd.service](https://www.freedesktop.org/software/systemd/man/latest/systemd.service.html)
dan [systemd.kill](https://www.freedesktop.org/software/systemd/man/latest/systemd.kill.html).
