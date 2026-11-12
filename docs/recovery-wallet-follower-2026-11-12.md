# Pemulihan wallet follower — 12 November 2026

## Scope dan plan
1. Verifikasi service dan journal sebelum perubahan.
2. Backup immutable seluruh state dry-run dan konfigurasi, periksa SHA-256.
3. Nonaktifkan real trading: enabled=false, autobuyScenario=DRY_RUN, autoSell=false.
4. Reset hanya S14 dan S14-Alpha menggunakan initializer engine resmi ke modal pengujian $5. Riwayat dan posisi lama diarsipkan dalam backup; bukan SELL, bukan hasil AMM, bukan pemulihan modal riil. S15 dan skenario lain tidak diubah.
5. Start service yang sudah ada; verifikasi status, heartbeat, koneksi browser, konfigurasi dan state setelah start.
6. Commit dokumen hasil verifikasi, tanpa memasukkan data pribadi/runtime atau file milik pekerjaan lain.

## Temuan sebelum perubahan
- Service inactive/dead; ExecStop normal SIGTERM pada 11 November 2026 22:08:54 WIB, sesuai journal systemd.
- S14 cash $0.28; open BOL dan mihao; 9 closed trades.
- S14-Alpha cash $7.76; open BOL dan mihao; 6 closed trades.
- S15 (`s14_beta`) cash $5.00; tanpa posisi/trade.
- Config enabled=true, autobuyScenario=S13_BETA: restart tanpa perubahan berpotensi mengaktifkan transaksi nyata.
- Kondisi pool mati berasal dari laporan user; belum diverifikasi on-chain ulang. Reset administratif tidak memerlukan asumsi harga atau kuotasi jual.
- Perbaikan logika heartbeat timeout/dead-pool bukan bagian langkah pemulihan ini; perlu fase terpisah dengan test.

## Hasil terverifikasi
- PASS: start pada 12 November 2026 09:07:09 WIB; PID 3807696; active/running; NRestarts=0 setelah observasi startup.
- PASS: CDP GMGN, WebSocket GMGN, dan dev Solana WebSocket terhubung menurut journal. Heartbeat tercatat 09:07:22 dan 09:07:52 WIB.
- PASS: S14 dan S14-Alpha masing-masing cash $5, invested $0, openPositions kosong, totalTrades 0 untuk sesi baru.
- PASS: 16 skenario non-target identik dengan backup sesudah startup; termasuk S15 cash $5 tanpa posisi.
- PASS: enabled=false, autobuyScenario=DRY_RUN, autoSell=false dibaca kembali setelah start.
- PASS: kedua backup non-kosong dan SHA-256 cocok sebelum reset dan sesudah startup.
- PASS: dashboard lokal `/add-fol/3scenarios/` port 4192 HTTP 200.
- PARTIAL: belum ada sinyal trade baru dalam jendela observasi; jalur entry/exit AMM baru belum diuji pada pemulihan ini. Tidak menjalankan unit suite karena tidak ada perubahan logic strategi.
- Catatan: warning native bigint binding menggunakan fallback pure JS; service tetap berjalan, bukan crash.

## Arsip dan accounting
Directory backup: `data/recovery-wallet-follower-1794449222061/` (permission 0700).
- `dryrun-3scenarios-live.json`: 480924 byte; SHA-256 `2c87fe8a9b2843e5561470268126526185cb8b49c1d15607fef427a101c7307d`.
- `follower-autobuy-settings.json`: 882 byte; SHA-256 `3f210b49a32780ffe0c4974c1ca9a410febf44f22d3d434cf2cebe6eb1f3b2bf`.
- `manifest.json`: target, timestamp, checksum, jumlah arsip, dan penanda `ADMINISTRATIVE_PAPER_SESSION_RESET_NOT_A_SELL`.
- Diarsipkan: S14 2 posisi terbuka + 9 closed trades; S14-Alpha 2 posisi terbuka + 6 closed trades.
- Tidak membuat quote, SELL, realized profit/loss, atau broadcast fiktif. Riwayat sesi sebelumnya dipertahankan di backup, bukan dicampur dengan metrik sesi baru.

## Rollback aman
Stop worker lebih dulu. Restore JSON dry-run dari backup hanya jika memang ingin kembali ke sesi lama, lalu verifikasi parse/schema. Jangan restore konfigurasi backup mentah sebelum start: backup memuat real auto-buy aktif. Pertahankan enabled=false, autobuyScenario=DRY_RUN, autoSell=false. Start kembali dan wajib periksa status + journal agar kejadian worker tertinggal mati tidak terulang.
