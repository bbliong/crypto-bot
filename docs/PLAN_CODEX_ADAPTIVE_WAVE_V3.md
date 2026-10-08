# Rencana Codex Adaptive Wave v3

## Keputusan desain

**Satu pengendali yang memilih strategi menurut kondisi, bukan satu set angka untuk semua token/jam.** ID `codex-adaptive-wave-v3`, terpisah dari AGY. Targetnya profit bersih dan risiko yang lebih baik dari AGY, bukan sekadar win rate lebih tinggi. Belum ada klaim target itu tercapai.

Urutan keputusan wajib: **kualitas data dan bahaya → kondisi token → biaya eksekusi → bukti regime/jam → pengelolaan posisi**. Jam yang historis bagus tidak boleh mengalahkan tanda dump, data hilang, biaya terlalu besar, atau order yang belum selesai.

## 1. Apa yang dibaca setiap saat?

Window 2s untuk perubahan mendadak, 5s untuk entry/momentum pendek, 20s untuk kesinambungan flow; evaluasi penelitian setiap 250ms. Semua memakai informasi yang sudah diterima saat keputusan, bukan timestamp kejadian yang datang terlambat tetapi dianggap sudah diketahui.

- Buy/sell USD, buyer/seller unik, porsi buyer terbesar, return dan drawdown.
- Efisiensi arah harga: `abs(sum(logReturn1s)) / sum(abs(logReturn1s))`. Mendekati satu berarti bergerak searah; kecil berarti bolak-balik. Ini indikator, bukan probabilitas profit.
- Volatilitas RMS perubahan log per bucket satu detik. Nilai return5 tinggi tidak otomatis dianggap ukuran volatilitas.
- Distribusi holder/dev dari snapshot sebelum transaksi, freshness, penjualan pemilik besar, dan crash satu detik.
- Biaya all-in, minimum output, quote latency, serta status koneksi/transaksi. Komponen quote/receipt lengkap masih memerlukan runner shadow terpisah; replay saat ini memakai biaya model.

## 2. Strategi yang dipilih berdasarkan situasi

| Situasi teramati | Mode | Keputusan |
|---|---|---|
| Beli baru kuat dan tersebar, arah cukup bersih, belum punya histori panjang | IMPULSE | Entry selektif, perlindungan profit cepat, hold maksimum45s |
| Beli bertahan pada 5s dan20s, arah bersih, tanpa dominasi satu wallet | TREND | Beri ruang trailing sesuai volatilitas, maksimum90s |
| Pullback terkendali, lalu pembeli kembali dan harga pulih | RECLAIM | Konfirmasi pemulihan; jangan membeli ketika masih jatuh; maksimum45s |
| Harga bolak-balik, flow melemah, bukti tidak lengkap, biaya terlalu besar | WAIT | Tidak entry; terus observasi shadow |
| Dev/holder dump, flash crash, atau bukti struktural berbahaya | DEFEND | Batalkan rencana entry; posisi yang sudah terisi meminta exit, bukan menganggap pasti berhasil sell |

Parameter hipotesis awal yang dibekukan:

| Filter | IMPULSE | TREND | RECLAIM |
|---|---:|---:|---:|
| Histori minimum | 7s | 22s | 22s |
| Return5s | +1..8% | +0,5..10% | 0..8% |
| Buy share5s | ≥75% | ≥65% | ≥65% |
| Buy share2s | ≥70% | ≥60% | ≥80% |
| Buy share20s | Tidak wajib | ≥68% | ≥55% |
| Buyer unik5s | ≥5 | ≥4 | ≥4 |
| Buy USD5s | ≥$500 | ≥$400 | ≥$500 |
| Efisiensi arah | ≥0,45 | ≥0,55 | Peak sebelum trough, rebound2..5%, di atas weighted price |

Semua tetap membutuhkan umur≥60s, MC$10k–100k, holder≥100, Top1≤8%, Top5≤25%, dev≤2,5%, histori/holder/count/dev valid, drawdown5≤2,5%, return2 positif, ≥5trade, dan round-trip cost model≤4%. Buyer terbesar≤50%; IMPULSE≤35%. Setup harus dikonfirmasi dua tick berbeda150–500ms. Filter adalah hipotesis yang akan dinilai, bukan angka optimal yang sudah terbukti.

## 3. Jam berapa menggunakan apa?

**Belum boleh menetapkan jadwal pasti seperti “malam TREND, pagi SCALP” tanpa bukti yang cukup.** Gunakan enam blok WIB: 00–04,04–08,08–12,12–16,16–20,20–24; untuk setiap blok, simpan hasil ketiga regime.

Aturan pembelajaran yang sudah dibuat:

1. Hanya hasil shadow yang tersedia sebelum waktu keputusan. Trade yang masih berjalan tidak membocorkan hasil masa depannya.
2. Jendela tujuh hari; satu observasi terbaru per mint per regime agar satu token berulang tidak membesarkan sampel.
3. Minimum20 mint dan3hari berbeda untuk bukti global suatu regime.
4. Statistik jam baru diberi bobot ketika blok itu sendiri punya≥20mint/3hari. Sebelumnya kembali ke global, bukan memercayai beberapa win.
5. `bobotJam = nJam/(nJam+40)`. Mean jam disusutkan ke mean global. Skor konservatif mengurangi mean dengan1,96×standard-error terbesar yang dipakai. Ini **heuristik**, bukan interval keyakinan formal untuk return crypto yang berekor tebal.
6. Unknown dibebankan sebagai penalti risiko−100% dalam pembelajaran dan porsinya harus≤5%; tidak dianggap transaksi riil sudah rugi100%.
7. Jika skor konservatif≤0 atau sampel belum cukup: **SHADOW/WAIT**. Jam tidak membuka trade yang tidak punya setup token valid.

Prosedur pembelajaran dibekukan, tetapi statistik dapat diperbarui setelah trade selesai. Loss streak/cooldown adalah risk control, bukan alasan mengubah parameter agar cocok dengan loss terakhir. Tidak memakai martingale.

Tambahan yang direncanakan untuk runner forward: kesehatan universe token yang sedang dipantau pada15–30menit terakhir (proporsi crash, kualitas quote, failed sells). Itu bukan indeks seluruh pasar crypto; sampel detail bot mempunyai selection bias. Jika memburuk, kurangi aktivitas atau WAIT meskipun kalender terlihat baik. Lapisan universe ini belum diimplementasikan pada prototipe v3.

## 4. Exit adaptif tanpa mengendurkan proteksi

- Penilaian profit memakai `100×(nilaiLikuidasiNetSOL/buyAllInSOL−1)`, bukan sekadar perubahan harga socket.
- Risiko awal: `max(−8%, netSaatBuy−4 poin)`. Stake/biaya lebih besar tidak disembunyikan sebagai loss harga. Tidak menambah posisi yang rugi.
- Dev sell≥$25/30s, holder dump disertai pelemahan harga, atau crash≥8%/1s: exit request segera.
- Flow reversal harus bertahan≥500ms dengan tick berbeda dan bukti sell cukup.
- Peak net≥4% mulai floor+0,5%; peak≥8% memakai floor minimum+2% dan trailing3–8% sesuai volatilitas/kekuatan trend.
- **Floor hanya naik.** Saat berpindah dari impulse ke trend, trailing boleh lebih longgar secara kandidat, tetapi floor yang sudah terkunci tidak boleh turun.
- Promosi mode harus bertahan≥1s dan melibatkan tick berbeda. Batas hold/risk awal tidak otomatis diperlebar oleh promosi.
- Permintaan exit → pending → fill terkonfirmasi. Tidak boleh menulis CLOSED hanya karena fungsi exit mengeluarkan sinyal.

Contoh: profit naik ke19%, floor sudah15,4%; kemudian peak20% dan volatilitas naik. Floor tetap setidaknya15,4%, bukan turun menjadi10% hanya karena berpindah kelas trailing.

## 5. Respons terhadap kejadian yang bukan sinyal entry biasa

| Event | Kebijakan |
|---|---|
| Tidak ada swap baru | Bedakan pasar sepi dengan socket putus melalui heartbeat; jangan memakai trade silence saja |
| Socket reconnect/gap/urutan event rusak | Hentikan entry, bangun kembali window; posisi lama tetap tercatat |
| Quote stale/divergen/impact besar | Refresh quote; jika tetap gagal, tolak entry |
| Sell simulation gagal / mint authority atau pool tidak diketahui | Tidak entry live; jangan menyamakan tidak ada data dengan aman |
| Buy timeout tetapi signature belum pasti | Rekonsiliasi signature dan balance sebelum retry |
| Sell gagal atau status ambigu | Posisi tetap terbuka; jangan membuka pengganti untuk menyembunyikan exposure |
| Tiga loss berturut-turut | Cooldown15menit; daily loss limit dua stake dalam prototipe portofolio |
| Tab berpindah /90s observasi selesai | Capture posisi harus berlanjut sampai rekonsiliasi; replay tanpa data mencatat UNKNOWN |

Sebagian respons di tabel adalah kontrak runner yang perlu dibangun, bukan fitur wallet live yang sudah tersedia. Tidak ada strategi yang bisa menjamin exit saat likuiditas hilang atau chain gagal.

## 6. Cara mengalahkan AGY dengan pembuktian yang adil

Pembanding utama adalah fungsi AGY yang diimpor collector dari `momentum-strategy.ts`, bukan hanya file standalone `adaptive-wave.ts`. Dalam source saat audit:

- Exit native membaca `p.peak`, tetapi tidak memperbaruinya; jalur pemanggil yang diperiksa tidak melakukan pembaruan peak untuk lane tersebut. Tes fixture memastikan trailing tidak terpanggil pada urutan harga yang semestinya mengaktifkannya bila peak dilacak.
- Potongan biaya keputusan exit tetap3%; bukan perhitungan actual all-in.
- Floor trailing dihitung ulang per rentang peak sehingga berpotensi turun saat batas rentang dilewati.
- `minStakeUsd` dan `maxCostRoundtripPct` dideklarasikan, tetapi tidak ditemukan pemakaian gate tersebut pada jalur entry native yang diperiksa.

Ini temuan teknis, bukan penilaian terhadap pembuatnya. File AGY tidak diubah. Perbandingan memakai empat kelompok:

1. **AGY_NATIVE**: fungsi native unchanged, termasuk perilaku peak-nya.
2. **AGY_REFERENCE**: entry native sama, peak dilacak dan net dihitung dengan model biaya yang sama; dibuat dalam adapter Codex agar kekurangan tersebut tidak menjadi satu-satunya alasan menang.
3. **CODEX_EVENT**: tiga regime adaptif, tanpa gate statistik jam, untuk mengukur kualitas rules sendiri.
4. **CODEX_GATED**: regime + bukti historis jam/global; boleh tidak entry.

Semua menggunakan adapter kualitas data yang sama, stake$5, buy9%/sell14%, delay1s; diuji ulang delay2s dan tambahan fee1%/sisi. Tidak menjual tepat pada harga stop jika harga sudah gap. Satu setup per detail dan satu percobaan/mint/24h diberlakukan sama—**bukan** replika penuh re-entry5s collector. MC/as-of holder memakai adapter bersama; hasil adalah perbandingan rule di harness, bukan klaim mereplikasi seluruh service AGY.

Data sebelum3Oktober12:00WIB adalah development yang sudah pernah dieksplorasi. Periode12:00–19:00WIB dipakai untuk pemeriksaan berikutnya; mint yang sudah muncul sebelumnya dipurge. Protokol dibekukan di `docs/CODEX_ADAPTIVE_V3_PROTOCOL.md` sebelum hasil periode itu dibaca.

Kriteria kemenangan: PnL bersih positif dan lebih baik dari kedua pembanding AGY, drawdown/tail/unknown tidak memburuk, cukup trade, tetap layak pada stress, lalu≥100trade forward pada≥7hari berbeda. Nol trade atau kerugian yang lebih kecil sendiri **bukan** bukti strategi profitable.

## 7. Implementasi dan tahap lanjut

Sudah dibuat: pengenal regime, exit dengan floor monoton dan pergantian mode stabil, gate jam as-of, adapter pembanding AGY, simulator biaya/delay bersama, serta tes perilaku. Tidak ada integrasi AutoBuy.

File utama:

- `src/codex-adaptive-wave-v3.ts`
- `scripts/codex-adaptive-engine.mjs`
- `scripts/replay-codex-adaptive-v3.mjs`
- `scripts/report-codex-adaptive-v3.mjs`
- `tests/codex-adaptive-wave-v3.test.ts`

Reproduksi offline:

```sh
node --import tsx scripts/replay-codex-adaptive-v3.mjs
node --import tsx scripts/report-codex-adaptive-v3.mjs
npm test
npm run typecheck
```

`--resume` hanya untuk capture lama yang tidak berubah; cache menyimpan fingerprint kode/protokol, bukan hash seluruh raw data. Hapus ketergantungan pada cache dengan menjalankan tanpa flag bila raw capture berubah.

Tahap berikutnya setelah bukti replay: runner Codex shadow terpisah, quote exact quantity + biaya/receipt, capture posisi kontinu, dan forward evaluation dengan parameter tetap. Integrasi real execution bukan bagian perubahan ini. Hasil bagian8 menentukan apakah rules boleh dilanjutkan; implementasi yang rapi saja bukan alasan promosi live.

Rujukan untuk memisahkan platform fee, priority/tip, dan slippage: [GMGN fees](https://docs.gmgn.ai/index/gmgn-fees-settings). Base/priority chain: [Solana fees](https://solana.com/docs/core/fees). Nilai fee replay adalah asumsi yang dinyatakan, bukan klaim receipt riil sudah direkonsiliasi.

## 8. Hasil benchmark

Replay selesai pada22.640 sesi:21.382 development dan1.258 sesi periode berikutnya. Setelah pembatasan satu setup/mint/24h, purge mint lama, dan cutoff180s, hasil test **3Oktober12:00–19:00WIB** adalah:

| Pembanding, stake$5 | Sinyal | Win / loss | Unknown | PnL model diketahui |
|---|---:|---:|---:|---:|
| AGY_NATIVE | 10 | 3 /7 | 0 | −$0,6889 |
| AGY_REFERENCE | 10 | 3 /7 | 0 | −$1,6910 |
| CODEX_EVENT | 1 | 0 /1 | 0 | −$0,1971 |
| CODEX_GATED | 0 | 0 /0 | 0 | $0, tidak entry |

**Status: NO_VALIDATED_OUTPERFORMANCE.** PnL absolut Codex yang lebih sedikit negatif berasal dari jauh lebih sedikit entry; tidak membuktikan keunggulan. Pada satu mint yang sama, Send, Codex−$0,1971 versus AGY_NATIVE+$0,3507 dan AGY_REFERENCE+$0,1828. Codex masuk/keluar pada waktu berbeda. Stress delay2s membuat satu posisi Codex tersebut UNKNOWN, bukan otomatis impas.

Pada development, CODEX_EVENT hanya17setup:2win,14loss,1unknown; mean posisi selesai−7,74%. AGY_NATIVE100setup:23win,65loss,5buy gagal,7unknown; mean selesai−3,54%. **Prototype Codex awal terlalu ketat dan tidak menunjukkan edge**, sehingga tidak disahkan walaupun modul adaptif dan tesnya berjalan.

Sampel regime/jam pada development:

| WIB | TREND | IMPULSE | RECLAIM | Keputusan yang didukung |
|---|---:|---:|---:|---|
| 00–04 | 3 | 0 | 0 | Shadow; sampel kurang |
| 04–08 | 1 | 0 | 0 | Shadow; sampel kurang |
| 08–12 | 4 | 0 | 0 | Shadow; sampel kurang |
| 12–16 | 3 | 1 | 0 | Shadow; satu win impulse bukan bukti jadwal |
| 16–20 | 2 | 0 | 0 | Shadow; sampel kurang |
| 20–24 | 3 | 0 | 0 | Shadow; sampel kurang |

Karena itu tidak ada dasar untuk mengatakan jam tertentu sudah terbukti harus memakai strategi tertentu. Tidak menurunkan batas minimum sampel sesudah melihat hasil hanya agar gate bisa trading.

## 9. Revisi arah riset setelah prototype ditolak

Rencana arsitektur adaptif dipertahankan; **rules entry v3 tidak dipromosikan**. Urutan riset berikutnya harus memisahkan sumber perbaikan:

1. **Same-entry exit study:** ambil seluruh kandidat AGY pada timestamp/kuantitas yang sama; bandingkan exit native, reference, dan empat exit Codex. Ini menguji apakah adaptive exit benar-benar menambah nilai, tanpa tercampur perubahan seleksi entry. **Pembaruan 4 Oktober: sudah dijalankan**, terpisah dari hasil v3 di atas; training ditolak dan validasi tambahan belum menunjukkan keunggulan. Lihat [hasil v4 dan rencana lanjut](CODEX_SAME_ENTRY_EXIT_RESULTS.md), termasuk posisi unresolved dan stress eksekusi.
2. **Regime sebagai pemilih perilaku, bukan tumpukan gate baru:** rekam konteks seluruh kandidat yang memenuhi safety/data gate. Mode mengubah konfirmasi/exit/risk, bukan menghilangkan hampir semua data pembelajaran. Perubahan ini versi eksperimen baru, bukan penyesuaian diam-diam v3.
3. **Pelajari jam dari seluruh shadow kandidat**, termasuk yang tidak dieksekusi, dengan outcome availability as-of dan biaya yang sama. Jadwal mulai berpengaruh hanya saat ada cukup token/hari independen dan efeknya stabil setelah shrinkage.
4. **Bekukan versi berikutnya sebelum periode baru.** Test12:00–19:00WIB di atas sekarang sudah terpakai; jangan menamai pengujian ulang pada periode itu sebagai holdout baru.
5. Bila PnL bersih tetap negatif pada kelompok entry yang sama, jangan menyelesaikannya dengan memperbesar stake atau mengurangi asumsi fee. Teliti waktu entry, kualitas quote, dan universe token; jika tidak ada edge, keputusan tetap no-live.

Koreksi peak AGY dalam reference juga tidak otomatis meningkatkan profit pada sampel ini. Temuan bug harus diperbaiki melalui jalur pemilik implementasi dan diuji, bukan dijadikan klaim Codex pasti lebih baik. Sesuai permintaan, implementasi AGY tetap tidak disentuh.

Laporan kecil: `reports/codex-adaptive-v3-summary.json`; ledger perbandingan: `reports/codex-adaptive-v3-comparison.json`; source/protocol hashes dan hasil per-source disimpan untuk audit. Verifikasi: **151/151 tes lulus**, typecheck lulus. Tidak ada perubahan konfigurasi live atau pengiriman transaksi.

## 10. Pembaruan engineering lanjutan, 4 Oktober 2026

Putaran v5–v13 selesai dengan59keluarga hipotesis tambahan; **belum ada keunggulan terverifikasi atas AGY**. Cost Tempo independen v12 dan pemeriksaan ulang v13 sudah diimplementasikan/diuji secara offline; keduanya masih negatif. Ringkasan terpusat, batas cakupan data, dan satu rencana berikutnya ada pada [hasil engineering loop](CODEX_ENGINEERING_LOOP_RESULTS.md). Versi AGY tetap dipertahankan. Rencana ini bukan izin menjalankan AutoBuy.
