# AP1/AP2/AP3 + varian net TP10 — kontrak implementasi

## Tujuan dan scope

Tambahkan varian PAPER `AP1-10%`, `AP2-10%`, `AP3-10%` di samping AP1/AP2/AP3 yang tetap menjadi kontrol. Perbaiki accounting dan exit monitoring keluarga AP sebelum menguji TP net +10%. Tidak mengubah entry/grace/bundler/filter whale/SL/trailing. Tidak mengaktifkan real orders. Tidak menghapus/reset/merekonstruksi histori lama atau mengoreksi angka lama dengan asumsi.

## Tahap dan acceptance

### A — Accounting dan lifecycle (TDD → commit)

- BUY quote memakai actual affordable stake yang dicadangkan engine, bukan mengganti kembali menjadi nominal config $5.
- Quantity/price/cost basis berasal dari quote AMM kedua yang benar-benar dipilih; kedua probe diaudit. Quote kedua gagal/throw/malformed: batal, refund reservasi tepat sekali, tanpa fill spot.
- BUY pending tidak boleh bisa dijual/TP sebelum quote sukses; event harus membedakan intent dari quote-settled.
- Fee model paper $0.025 per leg disimpan eksplisit dan hanya dibebankan sekali per leg. Principal, cash outlay, actual proceeds, partial proceeds dan fee tidak didobel saat full exit. Raw precision tidak dibulatkan terlalu dini.
- Exit adalah intent dahulu. Kas/profit/token/closed trade hanya berubah setelah SELL quote valid untuk exact lane+mint+position+quantity. No-route/timeout tidak boleh menjadi closed loss -100% otomatis.
- Pending/unavailable/legacy-unreconciled tetap terlihat dan exposure tidak dianggap cair. Quote callback duplikat/stale/restart tidak boleh menyebabkan cash/profit berubah dua kali.
- Histori trade lama tetap utuh, diberi batas accounting-version/provenance; tidak mengklaim angka lama sudah rekonsiliasi.

### B — Exit monitoring bounded (TDD → commit)

- Monitor posisi aktif keenam AP, independen dari signal whale dan chart. Interval/cooldown/TTL/timeout/concurrency eksplisit dan bounded; fair round-robin.
- Exact position tokens/base units dan pair untuk quote SELL; tidak memakai saldo token wallet riil untuk PAPER.
- Quote spot/token_stat tidak boleh mengisi proceeds atau menutup posisi. Failure → EXIT_UNAVAILABLE/OPEN_UNPRICED + error/attempt/lastFreshAt, retry bounded tanpa burn/sign/broadcast.
- Jangan menambahkan filter entry atau mengubah SL. Monitoring mendukung trigger safety asli, bukan membuat entry/exit policy baru yang tidak disepakati.
- Hanya posisi aktif; bukan polling semua kandidat/token historis; jangan memulai browser atau service baru.

### C — Tiga varian (TDD → commit)

- Nama UI persis `AP1-10%`, `AP2-10%`, `AP3-10%`; internal identifier eksplisit, tidak alias substring yang salah ke AP lama.
- Entry gate dan safety masing-masing diwarisi dari AP asal, tetapi cash/positions/trackers/history/inflight/no-rebuy terisolasi per lane.
- Varian mengganti TP bertahap spot +50/+100 dengan FULL EXIT hanya ketika quote liquidation seluruh posisi yang masih fresh menghasilkan net PnL >=10% sesudah buy+sell fee. Tidak mengubah SL/trailing/whale gate/hoarding.
- Formula untuk posisi awal tanpa partial: cashOutlay = principal + buyFee; netLiquidation = grossQuoteUsd - sellFee; pnlPct = (netLiquidation - cashOutlay)/cashOutlay*100. Fee DEX yang sudah di quote tidak dikurangi lagi tanpa kontrak eksplisit.
- Clones PAPER ONLY, harus ditolak real-order guard bahkan config enabled=true + BOTH/ALL atau alias eksplisit varian.
- Tambahkan state baru secara additive. Baseline lama tidak disalin sebagai closed history varian dan tidak di-reset. Jika kontrol lama kas habis, label perbandingan kapital/cohort tidak setara—jangan mengklaim performa A/B sebanding.

### D — UI, dokumentasi, verification

- Dashboard dan timeline menampilkan keenam lane, PAPER-only untuk varian, prefix/nama benar, status pending/unavailable/freshness dan angka accounting version jujur.
- Route/API/UI varian terpisah dan tested. Tidak menyediakan tombol real arm varian.
- Focused regression, tests no-rebuy lama yang perlu disesuaikan ke quote-only, routing safety, restart/persistence, concurrency, timeout/no-route, exact fee/+10% boundaries, partial accounting control, UI render/route smoke, typecheck baseline comparison, git diff --check.
- Offline fixtures digunakan untuk behavior, TIDAK diklaim profit hasil kuotasi pasar riil. Uji quote paper live dipisahkan dan hanya dilakukan bila existing CDP/session tersedia; tidak membuat hasil historis alternatif atau menyalakan real execution.

## Operational safety dan ownership

Source awal HEAD `f59bc89`. Working tree tracked bersih; banyak untracked script investigasi di luar task jangan disentuh/stage. Service follower dan dashboard sedang berjalan dari 12:52 WIB; state/config live jangan ditulis oleh coding/test. Eksekusi test di TMPDIR scratch/dataDir terisolasi.

Agy sebelumnya berhenti karena quota; writer task lama sudah quiescent. Implementasi boleh dilakukan fallback Hermes/delegated coding worker, satu writer. Parent memverifikasi independen dan mengelola deployment paper jika semua gate lulus. Tidak push tanpa instruksi.

## Batas hasil

Implementasi/tes bukan bukti strategi TP10 profitable. Historical SELL quotes pada trigger alternatif tidak tersedia; status evaluasi PnL historis tetap UNKNOWN. Jangan mengubah hasil penelitian lama atau memasukkan output fixture sebagai laporan return AMM nyata.
