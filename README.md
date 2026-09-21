# GMGN — automasi Playwright

Monitor ini menjalankan Chrome headful melalui Playwright dan mendengarkan WebSocket GMGN sebelum navigasi feed. Tidak memakai ekstensi ataupun headless. Pada Phase 1, keputusan hanya memakai field WebSocket GMGN yang sudah dipetakan dan terverifikasi: umur token, holder, likuiditas, buy, sell, dan konsentrasi Top-10. Mode manual membuka Fomo pada tab Playwright yang sama setelah `ENTRY_READY`; tidak ada buy, sell, signing, atau transaksi otomatis.

## Jalankan

1. Di folder proyek: `npm install`, lalu `npm start`.
2. Di Chrome buka `chrome://extensions`, aktifkan Developer mode, pilih **Load unpacked**, lalu folder `C:\Projects\Crypto\extension`.
3. Aktifkan tab GMGN yang sudah terbuka. Klik ekstensi **GMGN Existing Tab Listener**.
4. Salin kode koneksi dari terminal atau `reports/extension-connection.txt`, lalu klik **Mulai pada tab GMGN aktif**.
5. Angka `frames` dan `received` di terminal harus bertambah. Ringkasan tersimpan di `reports/live-status.json` dan `reports/probe-summary.json`.

Chrome menampilkan pemberitahuan debugging karena ekstensi menggunakan API debugger untuk membaca event Network. Jika Chrome menolak attachment karena DevTools/debugger lain, hentikan debugger itu secara manual lalu klik Mulai. Tidak ada upaya mengatasi CAPTCHA/challenge.

`npm run probe` hanya mengumpulkan struktur channel. `npm run probe -- --seconds 60` membatasi durasi server; Chrome tetap terbuka. `Ctrl+C` menghentikan server. Tombol Hentikan listener melepaskan debugger.

Memerlukan Node >=22.13 untuk SQLite. Runner dapat memakai runtime Node bawaan Codex bila Node sistem masih versi 20. Semua data lokal di `data/` dan `reports/`; gunakan `npm run typecheck` dan `npm test`.

## Yang tersedia

- Listener tab aktif dan worker GMGN; reconnect teramati otomatis.
- Server penerima hanya bind ke 127.0.0.1, memakai kode koneksi acak.
- Inventaris channel, struktur field, jumlah pesan, waktu observasi, versi parser.
- Parser mapping eksplisit, validasi mint base58 32 byte, deduplikasi serta checkpoint holder 25/50/75/100.
- SQLite WAL, fast/deep risk rules, penolakan data kritis yang hilang/kedaluwarsa.
- Opsional verifikasi mint/authority Solana melalui env `SOLANA_RPC_URL`.
- Mode observation (default), paper (sinyal observasi), manual (membuka tab Fomo untuk ENTRY_READY).
- URL Fomo berasal dari contoh pengguna: `https://fomo.family/tokens/solana/{mint}`.

## Batas implementasi saat ini

Mapping token live masih kosong sampai channel token yang sebenarnya diamati dan diverifikasi. Sampel `chain_stat/route_info` dan `public_broadcast/twitter_watched` adalah routing/broadcast, bukan bukti token baru; `gk` tidak dijadikan mint.

Socket yang sudah terbuka sebelum attachment tidak mengirim ulang handshake. Frame JSON berbentuk GMGN tetap dicatat, tetapi sumber diberi label `handshake-not-observed`. Tidak ada riwayat frame sebelum listener terpasang.

Probe menyimpan schema, bukan body frame mentah atau cookie/authorization/query URL. Kode koneksi adalah rahasia lokal sementara; jangan dibagikan. Jika memerlukan pemetaan field, gunakan contoh frame token yang sudah disanitasi.

Lima kelompok risk rules tersedia, tetapi ekstraktor holder lengkap, bundling, wallet graph, LP, Token-2022, dan validasi on-chain menyeluruh belum diverifikasi dengan feed live. Tidak ada nilai default PASS. Data parsial tetap UNKNOWN/INSUFFICIENT_EVIDENCE. Token-2022 saat ini memerlukan decoder tambahan untuk lolos extension checks.

Listener pasif tidak membuka tab analyzer otomatis. Detail token perlu tersedia pada tab GMGN yang Anda buka. Mode manual membuka/menggunakan ulang satu tab Fomo pada Chrome yang sama. Tidak ada BUY/SELL, wallet signing, atau transaksi otomatis.

`assessExit` menyediakan perhitungan target net +50% dari fill aktual dan quote executable untuk seluruh posisi, tetapi belum tersambung ke fill/quote Fomo live. Paper mode mencatat harga referensi, bukan fill executable. Penilaian outcome 1–15 menit, ATH/drawdown pascasinyal, dan pemantauan posisi otomatis belum tersedia.

## Mapping data

Edit `config/rules.yaml`, lihat contoh `config/mappings.example.yaml`. Gunakan channel, chain, mintPath dan timestamp units yang terbukti. Angka persen memakai 0..100; gunakan `scale: 100` untuk pecahan 0..1. Boolean harus boolean JSON.

Field numerik: createdAt, tradingStartedAt, holders, priceUsd, liquidityUsd, marketCapUsd, buys, sells, risePercent, drawdownPercent, top5Percent, top10Percent, singlePercent, bundledPercent, sameSlotWallets, sharedFunderWallets, largestClusterPercent, developerPercent, developerSoldPercent, transferFeePercent.

Flag kelengkapan/risiko: holdersComplete, ownersResolved, bundlingComplete, walletMapComplete, developerLinkedCluster, developerComplete, mintAuthorityActive, freezeAuthorityActive, lpWithdrawable, lpVerified, tokenExtensionsVerified, transferHookActive, mintVerified. Setiap flag harus berasal dari bukti terverifikasi, bukan konstanta.

Umur token berasal dari createdAt, bukan firstSeenAt. Setiap field memiliki timestamp sendiri. Semua critical checks harus tersedia dan fresh untuk ENTRY_READY. Satu WARN menjadi WATCH; >=2 WARN atau >=1 FAIL menjadi REJECT.

Replay file JSONL lokal: `npm run replay -- path/to/frames.jsonl`. Contoh sintetis pada tes bukan dokumentasi schema GMGN.
