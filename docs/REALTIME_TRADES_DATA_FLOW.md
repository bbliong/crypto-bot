# Audit data trade realtime

Audit dilakukan sebelum perubahan kode pada 5 Oktober 2026.

## Temuan sebelum perubahan

- `src/research-collector.ts`: `writeSimulation()` menormalisasi lane dan memanggil `appendFileSync()` melalui `write()` untuk `simulated-trades.jsonl`. BUY menyimpan `entryPriceUsd`, `stakeUsd`, `observedAt`, dan biasanya `positionId`. SELL menyimpan `exit.priceUsd`, `pnlPercent`, `pnlUsd`, dan `entry.openedAt`; sebagian record lama tidak memiliki `positionId`.
- Worker tidak meng-upsert tabel `trades` saat LIVE. SQLite `research.sqlite` milik holder store merupakan penyimpanan berbeda, bukan tabel trade dashboard di `data/crypto-bot.sqlite`.
- `upsertSqliteTrade` hanya alias import `upsertTrade` pada dashboard, tanpa pemanggilan. Fungsi `upsertTrade()` di `scripts/crypto-db.mjs` tetap tersedia.
- `findAggressiveRuns()` menggunakan slot WIB 3 jam saat ini sebagai LIVE, termasuk membuat descriptor run ketika belum ada row SQLite. Ini adalah klasifikasi berdasarkan waktu, bukan deteksi proses worker. Daftar run di-cache 5 detik.
- Versi Git `/api/trades` hanya mengambil closed trade dari SQLite. Workspace saat audit sudah memiliki perubahan lokal yang membaca JSONL untuk LIVE. Perubahan lokal itu belum mempertahankan `swapRoute`, stake per BUY, return dari `pnlPercent`/`exit.priceUsd`, dan pagination SQL archive.
- `getAggressiveDashboardData()` menggunakan JSONL untuk LIVE. Untuk archive, fungsi mencoba SQLite lalu fallback ke disk jika `hasUnsyncedDiskTrades` bernilai benar: SQLite tidak memiliki trade dan file simulated trades berukuran lebih dari 50 byte. Ini bukan sinkronisasi, dan tidak mendeteksi SQLite yang hanya terisi sebagian. Hasil agregator di-cache 1,2 detik.
- Frontend mengambil `/api/summary` dengan jeda 2,5 detik setelah siklus selesai. `/api/trades` dipanggil saat awal, pergantian run/lane/halaman, serta ketika jumlah closed trade berubah pada halaman pertama.
- Tidak ditemukan definisi maupun pemanggilan `syncTradesFile` pada source repository.

## SQLite dan archive

`scripts/run-aggressive-momentum-agy.mjs` menjalankan collector untuk satu slot, menunggu child selesai, lalu memanggil `syncSingleRunToSqlite(fullOutputDir)`. Fungsi sync membaca simulated trades, quote, ledger, events, dan metadata; menulis trade serta data historical lainnya dalam transaksi SQLite. `scripts/migrate-json-to-sqlite.mjs` menyediakan migrasi batch.

Supervisor adalah satu-satunya pemilik sync archive. Collector menyelesaikan dan menutup file run, lalu exit; supervisor menunggu child benar-benar selesai dan menjalankan satu kali `syncSingleRunToSqlite(fullOutputDir)`. Percobaan sync collector setelah `RUN_COMPLETE` dihapus. Ini juga menghilangkan path import collector yang salah dan mencegah duplikasi `route_quotes`, karena sync saat ini memakai INSERT biasa untuk quote.

Root cause data LIVE SQLite kosong/stale adalah tidak adanya penulisan trade realtime ke tabel tersebut. Snapshot migrasi atau sync akhir sesi tidak dapat menjadi sumber kebenaran selama worker masih append JSONL.

## Mengapa payload/audit tidak dipakai untuk trade realtime

`order-api-payloads.jsonl` merekam request/response jaringan beserta body, headers, dan body base64. `order-api-audit.jsonl` merekam metadata HTTP yang disamarkan. Keduanya bukan event BUY/SELL paper simulation.

Pembacaan penuh yang ditemukan:

- `getRealExecutedTrades()` membaca payload untuk rekonstruksi transaksi riil.
- `getActiveWalletAddress()` membaca audit untuk menemukan wallet, termasuk fallback beberapa run.
- Endpoint on-demand untuk transaksi real, detail payload, dan `/api/data` memakai agregator penuh dan dapat membacanya.
- Collector memiliki pembacaan payload historical untuk pemulihan wallet/session. Skrip analisis offline juga membacanya. Ini bukan kebutuhan endpoint paper trades dan tidak diubah.

`/api/trades`, `/api/summary`, `/api/route-quotes`, dan daftar `/api/real-trades` LIVE tidak memanggil agregator payload/audit. Summary dan route quotes membaca file operasional untuk scorecard, posisi, worker, throughput, dan quote. Daftar real trade LIVE merekonstruksi data dari ledger/events tanpa payload dan tanpa write SQLite. Keempat endpoint tidak melakukan lookup wallet atau RPC balance/rent pada polling. Detail transaksi real/payload dan `/api/data` tetap dimuat on-demand lewat jalur penuh.

Pemisahan ini menghindari pembacaan puluhan MB dan panggilan wallet/RPC pada polling dashboard. Archive dan endpoint on-demand tetap memakai jalur penuh yang sudah ada.

## Flow

Sebelum (versi Git):

```text
Worker LIVE -> simulated-trades.jsonl
                        |
                  sync akhir sesi -> SQLite -> /api/trades -> Dashboard
```

Sesudah:

```text
Worker LIVE -> simulated-trades.jsonl -> reader + cache -> /api/trades -> Dashboard
                           quote-simulated-orders.jsonl --^ (pelengkap opsional)

Sesi selesai -> sync supervisor/migrasi -> SQLite -> /api/trades -> Historical
```

## Batas dan compatibility perubahan

- LIVE membaca simulated trades sebagai sumber utama, tanpa query tabel trades atau write SQLite realtime.
- Quote simulation hanya memperkaya field swap yang sudah dipakai frontend. Tanpa quote, trade tetap tampil memakai perhitungan fallback dashboard yang sudah ada; field `realReturnPercent` bukan jaminan confirmed fill.
- Response envelope, lane filter, urutan terbaru, pagination, field trade, dan `swapRoute` dipertahankan. Archive menggunakan COUNT dan LIMIT/OFFSET SQLite.
- Pencocokan SELL menggunakan position ID, atau mint/lane/entry time untuk legacy. SELL posisi/lane lain tidak boleh menutup BUY yang masih terbuka.
- Cache parsing dibatasi dua file. Setiap request memeriksa device, inode, size, mtime, dan ctime. File berubah dibaca ulang; belum diperlukan incremental tail reader pada ukuran saat audit.
- Missing/empty file menghasilkan daftar kosong. JSON rusak/incomplete dilewati per baris. Append berikutnya dibaca ulang, termasuk penyelesaian baris terakhir. Snapshot yang berubah saat dibaca tidak disimpan ke cache. Replacement, truncation, dan penghapusan file menginvalidasi cache.
- Logika trading, worker, sync SQLite, frontend, dan agregator summary tidak diubah. Klasifikasi LIVE tetap mengikuti slot 3 jam yang sudah ada.

## Validasi

`tests/aggressive-dashboard-trades.test.mjs` menguji reader dan server HTTP asli di project sementara dengan SQLite terisolasi:

- Missing/empty/malformed/incomplete JSONL, penyelesaian append, cache, replacement, truncation, dan perubahan saat read.
- Bentuk SELL worker, stake per trade, posisi berulang/lane berbeda, dan pembaruan quote.
- LIVE saat SQLite kosong maupun berisi trade stale, tanpa write SQLite saat request.
- Kesamaan field response dengan archive, lane filter, pagination, dan halaman melebihi batas.
- Sync fixture archive ke SQLite, lalu request historical setelah seluruh folder source dihapus.
- Instrumentasi pembacaan file yang mencatat dan menolak akses payload/audit; tidak ada akses tersebut dari `/api/trades`, polling LIVE `/api/summary`, route quotes, maupun daftar real trades.

Pengukuran reader pada data LIVE lokal saat audit (sekali ukur, bukan benchmark beban): simulated trades 2.070.510 byte, quote 2.545.691 byte, 234 closed trade, cold sekitar 179 ms dan warm sekitar 15 ms. Payload 58.300.792 byte dan audit 42.570.356 byte hanya di-stat, tidak dibaca. Ukuran/waktu dapat berubah ketika worker berjalan.

Perintah validasi: `npm test`, `npm run typecheck`, `node --check` untuk module JavaScript yang berubah, dan `git diff --check`. Repository tidak menyediakan script/config lint.
