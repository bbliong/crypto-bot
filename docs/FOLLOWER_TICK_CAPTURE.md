# add-fol/3scenarios — passive GMGN tick capture + decision evidence (Phase A/B)

Recorder ini menempel pada handler CDP follower yang sudah ada (`scripts/run-wallet-follower.ts`), bukan pada Feed Hub. Tidak ada WebSocket, API, service, atau order tambahan. Default **OFF**. Menyalakan fitur ini **bukan** mengaktifkan/mematikan auto-buy: kontrol real trading tetap konfigurasi follower tersendiri. Jangan restart worker live hanya untuk mencoba recorder tanpa audit konfigurasi dan izin operasional.

## Mengaktifkan pada peluncuran yang sudah disetujui

Set `FOLLOWER_TICK_CAPTURE_ENABLED=1` pada environment proses *sebelum* follower dijalankan. Untuk mematikan, hilangkan variabel atau isi `0` saat peluncuran berikutnya. Tidak ada perubahan perilaku strateginya dari pengaturan ini. Tidak ada backfill data sebelum peluncuran tersebut.

## Isi dan lokasi

`data/follower-ticks/<sessionId>/<UTC-chunk>-<part>/` memiliki `token-activity.jsonl`, `token-stat.jsonl`, `wallet-activity.jsonl` (hanya target wallet), dan `lifecycle.jsonl`. `manifest.json` berada dalam direktori session. Direktori `data/` sudah di-ignore oleh Git. Tiap baris merupakan satu item dari array `data` frame provider, bukan satu frame gabungan. Raw item diarsipkan setelah redaksi field kredensial; signature/wallet dalam payload masih data sensitif, jadi arsip tidak boleh dipublikasikan mentah.

Schema v1: `schemaVersion`, `sessionId`, `connectionId`, `requestId`, `receiveSequence`, `itemIndex`, `receivedAt` (Unix ms), `channel`, `mint`, `source=gmgn_browser_ws`, `raw`. Harga/jumlah/timestamp provider dibiarkan apa adanya dalam `raw`: `token_stat` **bukan** BUY; `token_activity` event yang bukan `buy` tidak dipaksa menjadi SELL dalam arsip. `receiveSequence` adalah urutan frame diterima bot, bukan urutan transaksi intra-slot. CDP yang dipasang ke koneksi lama mungkin tidak melihat event socket-created; frame dari socket yang belum teridentifikasi positif sebagai GMGN tidak diarsipkan (strategi tetap memprosesnya seperti semula). Socket terputus, socket baru ketika ada mint tersubscribe, atau CDP reconnect menambah `coverageGaps` dan menandai manifest `INCOMPLETE`, karena subscription sebelumnya belum tentu aktif pada koneksi baru; Phase A tidak mengirim ulang subscription. Lifecycle `subscribe_sent` hanya berarti `ws.send` berjalan, **bukan** ACK provider. `unsubscribe_sent` hanya dicatat setelah kedua pesan dikirim. `first_tick_received` berarti data pertama terlihat.

Writer memakai antrean asynchronous terbatas: maksimal 20.000 record / 32 MiB, rotasi setiap 30 menit UTC atau 64 MiB per chunk; tidak ada sampling, retensi otomatis, fsync per baris, atau jaminan data lengkap jika crash. Manifest diperbarui setiap sekitar 5 detik dan saat stop normal; antrean data diberi waktu flush maksimal 5 detik sebelum `INCOMPLETE` dicoba ditulis (penulisan manifest sendiri tetap best-effort). Penulisan gagal dan antrean penuh menandai manifest `INCOMPLETE`; `received`, `written`, `dropped`, `writeUncertain` harus dibandingkan sebelum analisis. Manifest `OPEN` atau tidak ada berarti sesi tidak ditutup bersih; hitung baris arsip langsung dan nyatakan coverage belum pasti. `CLOSED` hanya berarti penutupan normal tanpa loss yang terdeteksi, **bukan** bukti feed provider/on-chain lengkap. Log warning recorder tidak menghentikan keputusan trading.

## Korelasi keputusan (Phase B)
`decisions.jsonl` terpisah dari feed pasar, satu baris per titik observasi. `scenario_action` dibuat saat callback strategi memicu action (termasuk cabang AP quoteTicket), `paper_simulation` ketika callback paper selesai/menolak promise (untuk AP yang menangani kegagalan quote secara internal, `ok=null` bukan klaim sukses), dan `amm_quote_request`/`amm_quote_result` sepasang untuk setiap pemanggilan helper route AMM skenario biasa (probeIndex 1/2), termasuk retry eksplisit setelah mismatch saldo. Prasyarat yang gagal sebelum helper dipanggil tidak dicatat sebagai quote request. AP BUY tercatat lewat audit quote lama; AP SELL monitoring periodik belum terkait actionId. `order_submit_attempt`/`order_response` hanya jika jalur order asli memang dipanggil, dan `rent_result`/`burn_close_result` hanya jika jalur lama mengembalikan hasil. Semuanya memakai `actionId` yang sama sepanjang jalur async/antrean. `order_response` adalah **respons API**, bukan bukti konfirmasi on-chain; label status lama dalam state trading tidak diubah. Tidak ada event `onchain_confirmation` sintetis. AP paper outcome tidak menjamin quote sukses: periksa audit AP yang terpisah. Retry internal di dalam satu helper dapat mengirim lebih dari satu HTTP request; arsip mencatat pemanggilan helper dan hasil akhirnya, bukan packet capture.

Field keputusan di-allowlist: sessionId, kind, actionId, scenarioId, mint, side, reason aman, positionId bila tersedia, observedAt, originFrame=null, status/ok, priceUsd, nilai quote base units/desimal/USD/exchange, orderId/hash, reclaimedSol, probeIndex. Payload route/order lengkap, cookie, URL query, key, dan error teks tidak diarsipkan di file keputusan. `originFrame=null` berarti callback async/timer tidak diklaim disebabkan tick terakhir. Quote AMM adalah kuotasi yang benar-benar dikembalikan helper, tetapi belum tentu transaksi yang terisi; nilai tidak dipakai untuk membuat PnL spekulatif. Jalur lane legacy di luar onTradeAction dan polling AP independen belum memiliki actionId skenario dalam arsip ini.

**Batasan Phase A/B:** tidak ada analyzer offline sebelum Phase C, observasi pasca-unsubscribe, atau pemastian konfirmasi on-chain independen. Follower masih memiliki perilaku lama `subscribedTokens.add(mint)` sebelum mengecek socket ready; event `socket_not_ready` mendokumentasikan risiko tersebut tanpa memperbaikinya diam-diam. Tick yang tak pernah sampai ke CDP tidak dapat diarsipkan. Harga di event bukan jaminan harga SELL yang dapat dieksekusi.

## Analyzer offline (Phase C)

Jalankan pada direktori satu sesi yang sudah direkam; analyzer hanya membaca file lokal, tidak memanggil provider, RPC, browser, service, atau order:

```bash
python3 scripts/analyze-follower-ticks.py data/follower-ticks/<sessionId> --mint <MINT>
python3 scripts/analyze-follower-ticks.py data/follower-ticks/<sessionId> --mint <MINT> --json
```

Timeline diurutkan menurut waktu observasi/terima dan sequence arsip bila tersedia; setiap tick mempertahankan `raw` dan label field harga sumber (`p`, `pu`, atau alias yang dikenali), tanpa menganggap token-stat sebagai transaksi. Field yang berbeda belum tentu punya unit/skala yang sebanding; gunakan `priceField` untuk menafsirkan sumbernya dan jangan membandingkan silang tanpa validasi provider. Keputusan digabung sebagai observasi terpisah; ini korelasi temporal, bukan klaim kausalitas. Analyzer menampilkan status manifest, row count, dropped/write-uncertain/coverage gaps, dan coverage harga token-stat. Sesi `OPEN`, `INCOMPLETE`, atau tanpa manifest tidak boleh diperlakukan sebagai rekaman lengkap. Field harga yang belum dikenali atau non-finite tetap null; jangan menafsirkan ketiadaan harga sebagai harga nol. Mode `--json` menyertakan raw payload untuk analisis offline; payload dapat memuat wallet/signature sensitif, jadi jangan publikasikan atau kirim mentah.

## Pengujian offline

```bash
node --import tsx --test tests/follower-tick-capture.test.ts tests/follower-tick-recorder.test.ts tests/follower-tick-parity.test.mjs tests/follower-capture-shutdown.test.ts
python3 -m unittest tests.test_follower_tick_analyzer -v
```

`npm run typecheck` diperiksa terhadap baseline repo; kegagalan awal dari file lain dilaporkan terpisah. Tes parity berbentuk `.mjs` karena mengimpor runner lama yang memiliki error TS laten di luar scope recorder.
