# Dokumentasi Reset Sesi Administratif AP1, AP2, AP3 (12 November 2026)

## Ringkasan Eksekusi
- **Waktu:** 12 November 2026, 12:52 WIB
- **Tujuan:** Membersihkan data simulasi/paper sebelumnya dan mengembalikan kas awal masing-masing skenario aktif (AP1, AP2, AP3) ke modal awal bersih **$5.00**.
- **Skenario yang Direset:**
  - `s14` (AP1: Bundler-Confirmed Runner)
  - `s14_alpha` (AP2: Bundler Runner + 60s Grace Period)
  - `s14_beta` (AP3: Bundler Runner + 60s Grace + Whale Hoarding Trap Defense)

## Prosedur Keamanan & Backup
1. **Service Halted:** Worker `crypto-bot-wallet-follower.service` dihentikan sebelum file state disentuh (`systemctl --user stop`).
2. **Immutable Backup:** Seluruh state dan konfigurasi auto-buy di-backup ke direktori terisolasi dengan permission `0700`:
   - Lokasi: `data/recovery-clear-data-1794462765893/`
   - Berisi file `dryrun-3scenarios-live.json`, `follower-autobuy-settings.json`, dan `manifest.json` (SHA-256 terverifikasi).
3. **Pembersihan State Administratif:**
   - Kas: `$5.00`
   - Realized PnL: `$0.00`
   - Invested Cash: `$0.00`
   - Total Portfolio Value: `$5.00`
   - Posisi Terbuka (`openPositions`): `0` (bersih)
   - Riwayat Trade (`closedTrades`): `0` (bersih)
   - Riwayat Event (`recentEvents`): `0` (bersih)
4. **Verifikasi Keamanan Real Mode:**
   - `enabled: false`
   - `autobuyScenario: "DRY_RUN"`
   - `autoSell: false`
5. **Restart & Verifikasi Runtime:**
   - Service `crypto-bot-wallet-follower.service` dan `crypto-bot-follower-dashboard.service` aktif (`active/running`).
   - Dashboard port 4192 mengembalikan HTTP 200 dengan nilai Kas $5.00 dan PnL $0.00 untuk AP1, AP2, AP3.
