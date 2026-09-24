# Deploy riset momentum-v2 di VPS

Panduan ini untuk VPS Ubuntu/Debian x86-64. Program yang dijalankan adalah **paper simulation**: collector Playwright membaca GMGN dan menulis laporan, tanpa mengirim order Buy/Sell. Jalankan hanya satu collector untuk satu profil Chrome.

## Port dan alamat laporan

`npm run dashboard:serve` menjalankan server HTTP pada **127.0.0.1:4173**. Collector (`npm run research`) tidak membuka port; ia menulis data di `research/<run-id>/` dan memperbarui `dist/paper-simulation-report.html`.

| Halaman | URL setelah SSH tunnel dibuat |
| --- | --- |
| Laporan run terbaru | `http://127.0.0.1:4173/paper-simulation-report.html` |
| Riwayat semua run | `http://127.0.0.1:4173/run-history.html` |
| Satu run tertentu | `http://127.0.0.1:4173/research-report/<run-id>` |

Server ini tidak memiliki autentikasi dan memang hanya bind ke `127.0.0.1`. Dari komputer Anda, buka tunnel:

```bash
ssh -N -L 4173:127.0.0.1:4173 crypto@IP_VPS
```

Biarkan terminal SSH tersebut terbuka, lalu buka URL di tabel pada browser komputer Anda. Jika port lokal 4173 terpakai, gunakan `-L 4174:127.0.0.1:4173` dan buka `http://127.0.0.1:4174/...`. Tidak perlu membuka port 4173 ke internet. Jika nanti ingin URL publik, pasang reverse proxy dengan HTTPS dan autentikasi di depan server ini.

## Persiapan VPS

1. Sediakan Node.js **>=22.13**, Git, dan Xvfb. Pada Ubuntu/Debian: `sudo apt-get update && sudo apt-get install -y git xvfb xauth`. Pasang Node.js 22+ sesuai distribusi VPS Anda lalu periksa dengan `node -v`. Program memakai Google Chrome asli (`channel: chrome`) dalam mode headed, sehingga VPS tanpa desktop memerlukan display virtual Xvfb. [Dokumentasi Playwright](https://playwright.dev/docs/ci#running-headed) menjelaskan kebutuhan Xvfb untuk headed Linux.
2. Buat satu user khusus, misalnya `crypto`, dan clone branch `momentum-v2` ke `/home/crypto/crypto-bot`. Pastikan commit terbaru sudah di-push sebelum clone atau pull. Gunakan user yang sama untuk login Chrome dan menjalankan service; jangan salin profil Chrome Windows ke Linux.
3. Di folder proyek, pasang dependensi dan Chrome:

```bash
cd /home/crypto/crypto-bot
npm ci
npx playwright install --with-deps chrome
mkdir -p profiles/research-vps research
npm run typecheck
npm test
```

Perintah instalasi browser/dependensi tersebut mengikuti [dokumentasi browser Playwright](https://playwright.dev/docs/browsers#install-system-dependencies). Siapkan sesi desktop/VNC pada display VPS untuk login GMGN pertama kali dengan profil `profiles/research-vps` milik user `crypto`. Contoh membuka profil pada display `:99`:

```bash
DISPLAY=:99 google-chrome --user-data-dir=/home/crypto/crypto-bot/profiles/research-vps --profile-directory=Default 'https://gmgn.ai/?chain=sol'
```

Selesaikan login di jendela tersebut, lalu tutup Chrome sebelum collector memakai profil yang sama. Xvfb sendiri tidak menyediakan tampilan interaktif; gunakan display yang sama saat login dan saat service berjalan. Akun dan cookie Chrome lokal Windows tidak otomatis ikut ke VPS.

## Menjalankan tanpa systemd untuk uji awal

Jika VPS sudah mempunyai display aktif, set `DISPLAY` ke display tersebut. Jika belum, jalankan Xvfb pada display `:99` terlebih dahulu:

```bash
Xvfb :99 -screen 0 1600x900x24 -nolisten tcp &
export DISPLAY=:99
```

Setelah profil GMGN login pada display itu, buka dua terminal sebagai user `crypto` di folder proyek:

```bash
npm run dashboard:serve
```

```bash
DISPLAY=:99 npm run research -- --strategy momentum-v2 --seconds 0 --workers 3 --profileDir profiles/research-vps --profileName Default
```

`--seconds 0` berarti **tanpa batas waktu run** (dan merupakan default). Maksimal **3 tab detail** dipakai bersama 1 tab feed. Setiap detail punya batas observasi 600 detik, tetapi slot dipakai kembali setelah detail selesai. Menutup Chrome collector atau menghentikan proses mengakhiri run. Perintah ini mengikuti `simulationStakeUsd` di `config/rules.yaml`; gunakan `--stake 0.25` bila ingin paper stake $0,25. Jangan jalankan collector kedua dengan profil yang sama karena Chrome mengunci profil aktif.

## Menjalankan otomatis dengan systemd

Contoh di bawah mengasumsikan user `crypto`, path `/home/crypto/crypto-bot`, dan `npm` berada di `/usr/bin/npm` (periksa `command -v npm`, lalu sesuaikan `ExecStart` bila berbeda).

`/etc/systemd/system/gmgn-display.service`:

```ini
[Unit]
Description=Virtual display for GMGN Chrome
After=network.target

[Service]
User=crypto
ExecStart=/usr/bin/Xvfb :99 -screen 0 1600x900x24 -nolisten tcp
Restart=on-failure

[Install]
WantedBy=multi-user.target
```

`/etc/systemd/system/gmgn-research.service`:

```ini
[Unit]
Description=GMGN momentum-v2 paper research
Requires=gmgn-display.service
After=network-online.target gmgn-display.service
Wants=network-online.target

[Service]
Type=simple
User=crypto
WorkingDirectory=/home/crypto/crypto-bot
Environment=HOME=/home/crypto
Environment=DISPLAY=:99
ExecStart=/usr/bin/npm run research -- --strategy momentum-v2 --seconds 0 --workers 3 --profileDir profiles/research-vps --profileName Default
Restart=on-failure
RestartSec=10
TimeoutStopSec=30

[Install]
WantedBy=multi-user.target
```

`/etc/systemd/system/gmgn-dashboard.service`:

```ini
[Unit]
Description=GMGN research report on localhost port 4173
After=network.target

[Service]
Type=simple
User=crypto
WorkingDirectory=/home/crypto/crypto-bot
Environment=HOME=/home/crypto
ExecStart=/usr/bin/npm run dashboard:serve
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
```

Jika tadi menjalankan `Xvfb :99` secara manual, hentikan proses manual itu dahulu agar service dapat memakai display `:99`. Aktifkan setelah profil Chrome siap:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now gmgn-display gmgn-dashboard gmgn-research
sudo systemctl status gmgn-research gmgn-dashboard
curl -I http://127.0.0.1:4173/run-history.html
```

Untuk melihat log dan menghentikan collector:

```bash
journalctl -u gmgn-research -f
sudo systemctl stop gmgn-research
```

Setiap restart collector membuat folder run baru dan riwayat lama tetap berada di `research/`. Setelah update kode, hentikan `gmgn-research`, lakukan `git pull` dan `npm ci`, lalu start lagi. Pertahankan folder `profiles/` dan `research/` saat update; keduanya diabaikan Git. Cadangkan keduanya secara privat karena profil berisi sesi login dan `research/` berisi data riset.
