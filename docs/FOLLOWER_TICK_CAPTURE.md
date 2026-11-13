# add-fol/3scenarios — passive GMGN tick capture (Phase A)

Recorder ini menempel pada handler CDP follower yang sudah ada (`scripts/run-wallet-follower.ts`), bukan pada Feed Hub. Tidak ada WebSocket, API, service, atau order tambahan. Default **OFF**. Menyalakan fitur ini **bukan** mengaktifkan/mematikan auto-buy: kontrol real trading tetap konfigurasi follower tersendiri. Jangan restart worker live hanya untuk mencoba recorder tanpa audit konfigurasi dan izin operasional.

## Mengaktifkan pada peluncuran yang sudah disetujui

Set `FOLLOWER_TICK_CAPTURE_ENABLED=1` pada environment proses *sebelum* follower dijalankan. Untuk mematikan, hilangkan variabel atau isi `0` saat peluncuran berikutnya. Tidak ada perubahan perilaku strateginya dari pengaturan ini. Tidak ada backfill data sebelum peluncuran tersebut.

## Isi dan lokasi

`data/follower-ticks/<sessionId>/<UTC-chunk>-<part>/` memiliki `token-activity.jsonl`, `token-stat.jsonl`, `wallet-activity.jsonl` (hanya target wallet), dan `lifecycle.jsonl`. `manifest.json` berada dalam direktori session. Direktori `data/` sudah di-ignore oleh Git. Tiap baris merupakan satu item dari array `data` frame provider, bukan satu frame gabungan. Raw item diarsipkan setelah redaksi field kredensial; signature/wallet dalam payload masih data sensitif, jadi arsip tidak boleh dipublikasikan mentah.

Schema v1: `schemaVersion`, `sessionId`, `connectionId`, `requestId`, `receiveSequence`, `itemIndex`, `receivedAt` (Unix ms), `channel`, `mint`, `source=gmgn_browser_ws`, `raw`. Harga/jumlah/timestamp provider dibiarkan apa adanya dalam `raw`: `token_stat` **bukan** BUY; `token_activity` event yang bukan `buy` tidak dipaksa menjadi SELL dalam arsip. `receiveSequence` adalah urutan frame diterima bot, bukan urutan transaksi intra-slot. CDP yang dipasang ke koneksi lama mungkin tidak melihat event socket-created; frame dari socket yang belum teridentifikasi positif sebagai GMGN tidak diarsipkan (strategi tetap memprosesnya seperti semula). Socket terputus, socket baru ketika ada mint tersubscribe, atau CDP reconnect menambah `coverageGaps` dan menandai manifest `INCOMPLETE`, karena subscription sebelumnya belum tentu aktif pada koneksi baru; Phase A tidak mengirim ulang subscription. Lifecycle `subscribe_sent` hanya berarti `ws.send` berjalan, **bukan** ACK provider. `unsubscribe_sent` hanya dicatat setelah kedua pesan dikirim. `first_tick_received` berarti data pertama terlihat.

Writer memakai antrean asynchronous terbatas: maksimal 20.000 record / 32 MiB, rotasi setiap 30 menit UTC atau 64 MiB per chunk; tidak ada sampling, retensi otomatis, fsync per baris, atau jaminan data lengkap jika crash. Manifest diperbarui setiap sekitar 5 detik dan saat stop normal; antrean data diberi waktu flush maksimal 5 detik sebelum `INCOMPLETE` dicoba ditulis (penulisan manifest sendiri tetap best-effort). Penulisan gagal dan antrean penuh menandai manifest `INCOMPLETE`; `received`, `written`, `dropped`, `writeUncertain` harus dibandingkan sebelum analisis. Manifest `OPEN` atau tidak ada berarti sesi tidak ditutup bersih; hitung baris arsip langsung dan nyatakan coverage belum pasti. `CLOSED` hanya berarti penutupan normal tanpa loss yang terdeteksi, **bukan** bukti feed provider/on-chain lengkap. Log warning recorder tidak menghentikan keputusan trading.

**Batasan Phase A:** belum ada correlation ID keputusan/quote/order, analyzer offline, atau observasi setelah unsubscribe token. Follower masih memiliki perilaku lama `subscribedTokens.add(mint)` sebelum mengecek socket ready; event `socket_not_ready` mendokumentasikan risiko tersebut tanpa memperbaikinya diam-diam. Tick yang tak pernah sampai ke CDP tidak dapat diarsipkan. Untuk analisis harga eksekusi, perlu quote AMM terpisah; harga di event bukan jaminan harga SELL yang dapat dieksekusi.

## Pengujian offline

`node --import tsx --test tests/follower-tick-capture.test.ts tests/follower-tick-recorder.test.ts tests/follower-tick-parity.test.mjs`

`npm run typecheck` diperiksa terhadap baseline repo; kegagalan awal dari file lain dilaporkan terpisah. Tes parity berbentuk `.mjs` karena mengimpor runner lama yang memiliki error TS laten di luar scope recorder.
