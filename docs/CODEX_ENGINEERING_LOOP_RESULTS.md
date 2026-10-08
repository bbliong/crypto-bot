# Codex engineering loop — hasil dan satu rencana berikutnya

Pembaruan 4 Oktober 2026. Status: **NO_VALIDATED_OUTPERFORMANCE / NO LIVE**. Pembanding AGY adalah Adaptive Wave V1, lane `adaptive-wave`, fungsi native di `src/momentum-strategy.ts`. `AGY_REFERENCE` adalah kontrol research tambahan dengan peak/net model, bukan source AGY asli. Source AGY, collector, config dan service tidak diubah oleh pekerjaan ini.

**Mode terbaru: EXISTING_DATA_ONLY.** Sesuai permintaan user, worker tunggu v17r1 dihentikan
secara graceful4Oktober20:46:36WIB; PID mati dan owned lock sudah dibersihkan. Tidak menunggu
window21:00 dan tidak ada worker Codex forward aktif. Catatan loop aktif di bawah merupakan
riwayat sebelum perubahan instruksi ini. Data/ledger tidak dihapus. Putaranv22 terbaru
sudah memeriksa14.660detail mentah tersimpan; bukan hanya89opportunity AGY sebelumnya.

## Hasil yang menentukan keputusan

Tabel ini hanya ringkasan PnL diketahui dari replay biaya, stake$5; bukan transaksi live. Cohort dapat berbeda. Unknown tidak dimasukkan sebagai realized loss, tetapi tetap diberi conservative bound di JSON, dan memblokir portfolio. Historical TRAIN/AUDIT sudah pernah dipelajari: jangan disebut holdout. TRAIN sebelum3Oktober12WIB, AUDIT sampai4Oktober10WIB.

| Kebijakan | TRAIN: win/loss; unknown | TRAIN PnL diketahui | AUDIT: win/loss; unknown | AUDIT PnL diketahui |
|---|---|---:|---|---:|
| AGY_NATIVE, seluruh opportunity | 13/37; 3, 1 buy-failed | −$8,0540 | 10/17; 2 | −$5,4540 |
| Peak recheck v10 FULL1500 | 3/8; 0, 1 buy-failed | −$0,3970 | 2/1; 0 | +$0,4469 |
| Cost Tempo v12, independent | 5/5; 0 | −$2,2934 | 4/3; 0 | −$0,6069 |
| Cost Recheck v13, wait750/peak | 2/2; 0 | −$1,0315 | 2/2; 0 | −$0,8894 |
| Breadth router v14 | 3/7; 0 | +$0,0675 | 0/0; 0 (29SKIP) | $0, tidak entry |
| Action-value v15 FLOW depth1 | 1/0; 0 | +$0,1621 | 0/1; 0 | −$0,0556 |
| Normalized breadth v16 | 3/7; 0 | +$0,0675 | 2/0; 0 | +$0,5025 |

V10 punya audit kecil positif, tetapi TRAIN negatif, hanya11closed, dan stress delay menghasilkan unknown. Bukan pemenang. V12/v13 lebih sedikit entry daripada AGY dan sama-sama negatif; lebih kecil rugi atau win-rate57% tidak membuktikan strategi profitable. V12 portfolio kebetulan menerima seluruh10TRAIN/7AUDIT, tetapi versi lain bisa berhenti lebih awal pada unresolved—baca portfolio masing-masing, bukan jumlahkan event PnL sebagai equity live.

### Apa yang dipelajari dari dua putaran terakhir

- V12 memeriksa seluruh **12.019 detail** dari25 sumber raw tersedia:10.549 memiliki tick,3.248 berdurasi≥90s,56 memakai akhir sesi inferred. Durasi90s tidak menjamin kontinuitas swap, heartbeat, quote, atau receipt. Empat konfigurasi diuji, semua TRAIN ditolak. Lambda0,25/TEMPO diagnostic primary, bukan rekomendasi live.
- V12 menggunakan `v=min(logReturn2/2,logReturn5/5)`, horizon3/5/8s menurut volatilitas, dan gate `projectedGross−breakEvenGross−lambda*sigma*sqrt(H+1)≥1pp`. Ini heuristic momentum, bukan estimator expected-profit. Pada10TRAIN, mean score+3,82pp tetapi net horizon teramati−3,92%; lima loss benar-benar pembalikan harga. Jangan menganggap skor itu formula keuntungan.
- V13 memeriksa ulang setup tersebut pada750/1500ms sebelum submission, lalu tetap membayar latency1/2s, mempertahankan total batas harga awal. Empat konfigurasi ditolak. Menunggu memotong peluang, tetapi tetap tidak mencegah trade Blob rugi≈36%. Recheck bukan jaminan anti-rugpull.
- Peak net/floor monoton, freshness, distinct-tick confirmation, biaya dua arah, min-output/retry dan unknown telah diuji. Bug source AGY tidak diperbaiki diam-diam; pembaruan peak hanya pada adapter eksperimen Codex.

Laporan rinci: `reports/codex-cost-tempo-v12-summary.json`, `reports/codex-cost-tempo-v12-diagnostics.json`, `reports/codex-cost-recheck-v13-summary.json`. Case-file hashes dan input terpilih disimpan untuk reproduksi. Laporan lama tidak ditimpa.

## Cakupan seluruh loop

Sejauh ini **88 keluarga hipotesis v5–v22**, bukan88 eksperimen statistik independen. Selection/protocol masing-masing dibekukan sebelum audit aggregation; tree v8/v15/v17/v20 tetap mengeksplorasi banyak split internal. Lebih banyak eksperimen pada dataset sama meningkatkan risiko overfit. V17 adalah satu prosedur learning future yang dibekukan, bukan hasil forward yang sudah selesai. Angka72 pada manifest v17 tetap dipertahankan sebagai catatan saat freeze. Audit quote tambahan adalah pemeriksaan data, bukan keluarga formula baru.

| Putaran | Hipotesis baru | Temuan singkat |
|---|---:|---|
| v5b: timing × exit, kemudian gate | 17 | AGE300 membantu seleksi; harvest tidak mengalahkan native pada opportunity AGE300 sama |
| v5c: price budget menurut sigma | 8 | TRAIN primary masih negatif; mature subset positif hanya2trade |
| v6: independent mature entry | 4 | Trend negatif, reclaim tidak entry; selector nol-entry bukan pemenang |
| v7: gate ablation | 4 | AGE300 audit positif tetapi training/stress gagal, fresh abstain saat AGY mendapatwin |
| v8: prequential evidence | 4 | Tidak ada model aktif; zero trading bukan edge |
| v9: prebuy recheck | 6 | FULL1500 audit3trade positif, TRAIN/stress gagal |
| v10: peak tracking | 4 | Perbaikan kecil pada recheck, tidak lolospromosi |
| v11: probation exit | 4 | Exit lebih cepat tidak memperbaiki primary TRAIN |
| v12: independent cost/tempo | 4 | Proyeksi momentum tidak bertahan; TRAIN/AUDIT negatif |
| v13: independent cost recheck | 4 | Entry lebih sedikit; TRAIN/AUDIT tetap negatif |
| v14: market breadth routing | 4 | TRAIN kecil positif, stress gagal; semua context cukup lengkapRED, audit abstain |
| v15: learned action value | 4 | TRAIN prequential hanya1win positif semua stress; AUDIT1loss, terlalu kecil |
| v16: volatility-normalized breadth | 4 | AUDIT2win positif, tetapi TRAIN stress tetap gagal |
| v17: online past-label learning | 1 | Catch-up sampai20:30WIB: enamopportunity, semua challenger WAIT/SKIP |
| v18: entry-buyer recycling exit | 4 | TRAIN−$10,8067; AUDIT−$7,2503; memotong sebagian recovery, ditolak |
| v19: deterioration-only recheck | 4 | TRAIN−$5,7645; AUDIT−$3,0247; fresh diagnostic0win/3loss, ditolak |
| v20: robust historical adaptive router | 2 | Semua89opportunity WAIT; profit0karena0trade, ditolak |
| v21: post-fill follow-through | 4 | Primary TRAIN−$8,1254/4unknown; AUDIT−$5,6329/3unknown, ditolak |
| v22: independent safe/context adaptive | 2 | Raw14.660detail; primary92entry,17win/58loss,16unknown,known−$23,0975; ditolak |

Replay frozen13:00–13:30WIB4Oktober mencakup138detail tetapi **0 native opportunity** untuk semua kandidat same-opportunity v8–v11. Tidak ada win/loss yang bisa disimpulkan dari interval ini. `reports/codex-joint-fresh-20261004T0600-0630-summary.json` mencatatnya.

Periode14:00–14:30WIB4Oktober untuk v12:115detail/103dengan tick, **0entry native dan0entry independent**. Output `reports/codex-cost-tempo-v12-forward-20261004T070000Z-20261004T073000Z-summary.json`. Tidak menghasilkan bukti keunggulan. Semua hash source AGY/config masih sama.

## Satu rencana berikutnya: frozen evidence, lalu adaptive router

1. **Tidak deploy kandidat yang gagal.** Pertahankan Codex terpisah; v10 hanya diagnostic comparator karena audit kecilnya positif, v12/v13 tetap research challenger. Jangan menambah stake atau mengurangi asumsi biaya untuk membuat kurva positif.
2. **Periode berikutnya harus baru dan aturan belajar tetap.** V17 sekarang menjalankan worker research tersendiri, mulai15:00WIB4Oktober, snapshot pertama15:30WIB. V12 evaluator lama tetap tersimpan tetapi tidak dijalankan berulang oleh worker ini. Evaluasi cumulative dari start tetap; jangan menjumlahkan laporan overlap atau reset portfolio tiap interval. Tidak ada service systemd/cron/AutoBuy baru.
3. **Belajar adaptive dari outcome yang telah tersedia**, bukan peak masa depan atau ciri loser yang baru diketahui. Calon router memakai arus2/5/20s, volatilitas, holder/dev danger, biaya dan kualitas quote; mode WAIT/SCALP/RUNNER/DEFEND. Implementasi tempo v12 sudah mengubah perilaku exit dengan persistensi mode dan floor monoton, tetapi efektivitas entry belum terbukti. Gate bukti jam as-of v3 tetap tersedia, belum ada cukup sampel untuk jadwal “jamX pakaiY”.
4. **Tutup gap eksekusi sebelum klaim realisme live:** quote exact-quantity/min-output/impact, receipt/slot/actual fee, heartbeat dan capture hingga posisi reconciled. Data hilang46/133signal lama tidak diam-diam dianggap aman atau direkonstruksi. Membuat collector Codex baru untuk cakupan itu adalah tahap terpisah, belum dikerjakan; jangan mengedit collector AGY sebagai jalan pintas.
5. **Syarat kemenangan tetap:** net absolut positif, mengungguli native danreference dengan risiko/unknown tidak memburuk pada base/delay/fee stress;≥30closed/3hari historical screening, lalu≥100trade/7hari forward dengan execution coverage cukup. Jika semua gagal, catat belum ada edge—bukan pilih zero-entry sebagai lane terbaik.

```sh
# Contoh: jalankan sesudah 4 Oktober 2026 14:30 WIB.
node --import tsx scripts/evaluate-codex-cost-tempo-forward.mjs --cutoff 2026-10-04T07:30:00Z
```

## Riwayat loop: Codex online forward v17

Worker dimulai4Oktober14:52WIB, PID awal2214548. Status hidup/heartbeat/PID terbaru ada di `reports/codex-online-forward-v17/latest-status.json`, bukan disimpulkan dari PID di dokumen ini. Saat mulai:RUNNING_WAITING_WINDOW, belum ada forward opportunity.

- Enam policy pada native opportunity yang sama: native/reference, peak-recheckv10, normalizedbreadthv16, fixed action-valuev15, online action-valuev17.
- V17 refit heads hanya dari label7hari sebelumnya yang **sudah tersedia** sebelum opportunity. Config/minleaf/shrink/positive threshold tetap. Actions direct/750ms/1500ms/WAIT. Semua future choices/model hashes tersimpan, dan keputusan lama diperiksa tidak berubah ketika future input ditambah.
- Membaca capture existing dan melakukan **fresh simulated rule replay**, bukan transaksi live/quote-exact fills. Worker tidak mengubah collector/config/service AGY. Case/context yang finalized disimpan untuk tahan raw cleanup; unknown tetap blocked.
- Window30menit, cumulative portfolio, embargo180s hanya pada ujung terakhir. Maksimal7hari/run dan512MiB artifacts, minimal2GiB free. Source berubah/resource limit→stop explicit, tanpa menghapus raw. Tidak menjanjikan formula pasti ditemukan dalam7hari.
- Stop sukses research hanya jika kandidat≥100closed/≥7hari WIB, positif dan better kedua controls pada semua stress dengan risk tidak memburuk, portfolio positif/tidakblocked. Labelnya **PROMISING_FORWARD_REPLAY, liveAllowed=false**, karena receipt/quote/connection coverage masih wajib sebelum deployment. Jika belum lulus sampai limit, status tetap belum ada formula terverifikasi.

Protokol lengkap: [online forward v17](CODEX_ONLINE_FORWARD_V17_PROTOCOL.md). Implementasi `scripts/run-codex-online-forward-v17.mjs`; jangan menjalankan worker kedua ketika owned lock/PID masih aktif. Tidak ada parameter sweep otomatis yang memilih ulang dari future test. Formula tree berubah hanya lewat prosedur causal learning yang dibekukan.

Pengujian akhir v17:239/239tes lulus, typecheck lulus. Full-engine historical parity mengembalikan54opportunity dan native PnL−$8,0540 yang sama; prequential online dry-run cocok v15+$0,1621—itu pemeriksaan engine, **bukan forward result**. Hash source AGY, collector dan config tetap sama; tidak ada transaksi dikirim.

## Pembaruan20:38WIB: pemulihan dan dua putaran tambahan

Pemeriksaan menemukan PIDv17 mati, heartbeat terakhir15:34WIB; penyebab terminasi tidak diketahui.
Config live berubah dari luar pekerjaan ini pada16:09WIB. Menjalankan ulang v17 mengonfirmasi
`SOURCE_CHANGED config/autobuy-settings.json`; config tidak dikembalikan atau diedit.
Cabang operasional **v17r1** dibuat dengan manifest provenance baru yang mengakui satu perubahan
config itu. Replay memakai konstanta biaya/stake yang dibekukan, tidak membaca config live.
Semua executable dependency lama tetap identik; case/keputusan/ledger lama dipertahankan.
Prefix keputusan lama diverifikasi tidak berubah. Ini pemulihan aturan sama, bukan hipotesis baru.

Catch-up aturan beku15:00–20:30WIB memproses1.418sesi:1.347sesudah start dan71warm-up;
semuanya punya akhir sesi tercatat. Ini jumlah sesi finalized yang diproses, bukan jaminan semua
detail/socket/quote pada interval tersedia; pending≤180s dikecualikan dan raw terhapus tak dapat
dipulihkan. Enam opportunity native lolos cohort. Bukan capture forward tanpa gangguan.

| Replay cumulative stake$5 | Base win/loss | Base net diketahui | Delay2s net | Fee2%/sisi net |
|---|---:|---:|---:|---:|
| AGY native | 2/4 | −$0,2200 | +$0,2378 | −$0,8246 |
| AGY reference | 2/4 | −$0,2207 | −$0,3080 | −$1,4769 +1unknown |
| Empat challenger v10/v16/fixedv15/onlinev17 | 0/0; semua6SKIP | $0 | $0 | $0 |
| v18 primary, retrospective diagnostic | 1/5 | −$0,4614 | −$0,6477 | −$1,0611 |
| v19 primary, retrospective diagnostic | 0/3;3SKIP | −$0,3680 | −$0,7165 | −$0,6651 |

Reference feeStress conservative bound−$6,5017 dan portfolio blocked; unknown tidak dihapus.
Baris v18/v19 bukan fresh holdout: aturan ditulis setelah aggregate catch-up terlihat, lalu
primary masing-masing dipilih TRAIN saja sebelum audit/catch-up evaluation. Semua delapan
variasi baru gagal. V18 memakai cohort wallet pembeli awal, bukan perkiraan inventory/insider;
kasus CatCollector memperlihatkan sell dini berubah dari fallback+$1,1984 menjadi−$0,1607.
V19 mengurangi double-gating ketat dengan veto deteriorasi saja, tetapi melewatkan tiga peluang
dan menerima tiga loss di catch-up. Tidak ada kandidat baru yang dipromosikan ke loop/live.

V18 primary COHORT_0.25_2: TRAIN49closed13win/36loss,1buyfailed,4unknown; net−$10,8067,
bound−$30,9045. AUDIT27closed8win/19loss,2unknown; net−$7,2503, bound−$17,2994.
V19 primary INVALIDATE_1000_PRICE: TRAIN25closed7win/18loss,2unknown; net−$5,7645,
bound−$15,8135. AUDIT15closed5win/10loss,1unknown; net−$3,0247, bound−$8,0493.
V19 delay2s TRAIN known+$0,6320 **bukan untung terverifikasi**: ada5unknown dan bound−$24,5169.

Worker v17r1 dihidupkan detached, tanpa memasang/mengubah systemd/cron, PIDawal2276063;
aturan online asli tetap belajar dari label masa lalu setiapwindow30menit. Batas waktu tetap
11Oktober15WIB, artefak512MiB/minimumdisk2GiB. Periksa PID **dan** heartbeat di
`reports/codex-online-forward-v17r1/latest-status.json`; proses detached tetap dapat mati.
Jika belum ada snapshot baru, hasil selesai terakhir ada di folder `snapshots/`, bukan field
hasil pada status yang diinisialisasi ulang. Jangan menjalankan worker duplikat.

Verifikasi setelahv19:247/247tes, typecheck dan diff-check lulus; pemeriksaan same-buy v18 pada semua skenario/partisi
lulus. V19 sengaja mengubah waktu buy, sehingga tidak diklaim same-fill. Laporan rinci:
`reports/codex-cohort-exit-v18-summary.json`, `reports/codex-invalidation-v19-summary.json`,
`reports/codex-online-forward-v17r1/snapshots/20261004T133000000Z.json`.
Keputusan tetap **NO_VALIDATED_OUTPERFORMANCE / NO LIVE**; tidak ada janji pasti untung.

## V20: formula memakai data yang sudah ada saja

Router memilih NATIVE / PEAK_DIRECT / INVALIDATE_500_PRICE / INVALIDATE_1000_PRICE /
PEAK_FULL1500 / WAIT. Target pembelajaran peraksi adalah minimum net base/delay2s/feeStress;
label baru tersedia setelah semua skenario selesai, dengan unknown tetap risk proxy.
Arsitektur FLOW/SAFETY depth1, min24history/min8leaf/shrink8, threshold$0,04 tetap.
Pilihan pada setiap waktu hanya memakai label yang sudah tersedia; bobot model diperbarui
secara kronologis, termasuk evaluasi historis, bukan melatih pada seluruh future sekaligus.

Dua konfigurasi diuji pada TRAIN54opportunity; keduanya0trade. Primary FLOW hanya pilihan
diagnostik deterministik, bukan pemenang. Primary kemudian menghasilkan0trade pada AUDIT29
dan catch-up6. Total89WAIT,0win/0loss/$0. Lebih ketat terhadap stress tidak menciptakan edge;
formula ini ditolak, bukan diberi label profitable karena menghindari trading.
Menambahkan label masa depan tidak mengubah keputusan TRAIN/AUDIT sebelumnya (assertion lulus).
Portfolio kumulatif tidak direset pada pergantianpartisi. Hour counts tersimpan, tetapi hanya
1–8opportunity perjam yang terwakili: tidak mendukung jadwal pakai strategi perjam.

Sumber `scripts/codex-robust-router-v20.mjs`, protokol `docs/CODEX_ROBUST_ROUTER_V20_PROTOCOL.md`,
hasil `reports/codex-robust-router-v20-summary.json`. Tiga tes baru lulus, termasuk waktu
availability gabungan, strictpast-label, dan nonpositive→WAIT; dependency hashes diverifikasi.
Data TRAIN/AUDIT/catch-up sudah dipelajari sehingga tetap evaluasi historis yang digunakan
ulang, bukan bukti out-of-sample independen. AGY/config/collector tidak diubah.

## V21 dan pemeriksaan ulang quote lintas-lane

Tetap EXISTING_DATA_ONLY: tidak menghidupkan loop tunggu. Diagnosis TRAIN native menunjukkan
26HARD_RISK_LIMIT, net−$15,1112, request rata-rata3,4745s sesudah buy. V21 menguji bukti
kelanjutan momentum: net harus membaik1/2pp dari net awal dalam2/4detik; sebelum bukti lolos,
penurunan2pp meminta sell, hardnet−6% tetap aktif. Exit native tidak ditunda; buy sama persis.
Primary dipilih TRAIN sebelum audit: FOLLOWTHROUGH_4000_1. Keempat konfigurasi gagal.

| Periode v21 primary, base | Win/loss | Unknown | PnL diketahui | Bound konservatif |
|---|---:|---:|---:|---:|
| TRAIN54opportunity | 13/36;1buyfailed | 4 | −$8,1254 | −$28,2227 |
| AUDIT29opportunity | 8/18 | 3 | −$5,6329 | −$20,7065 |
| Stored catch-up6 | 1/4 | 1 | −$0,7331 | −$5,7579 |

Jumlah event89opportunity bukan portfolio real: portfolio kumulatif berhenti pada unresolved
ketujuh,6closed,1win/5loss,known−$0,4312. Exit lebih awal terkadang tidak memiliki tick
setelah delay untuk mengisi sell; jangan mengisi harga stop atau menghapus unknown. Same-buy
assertions seluruh skenario/partisi lulus. Hasil `reports/codex-followthrough-v21-summary.json`.

Audit baru atas **4.610record** pada `reports/codex-all-history-audit.json` memisahkan
stake aktual, quote hilang, urutan waktu, dan kecocokan jumlah token dengan integer exact.
Tidak mengekstrapolasi quote stake$0,5 menjadi stake$5; platform fee yang sudah ada dioutput
route tidak dipotong dua kali. Hanya model network0,000205SOL/leg ditambahkan.

Temuan `aggressive-safe` stake$5 pada30September–1OktoberWIB:

- 173entry,143pasanganquote; **30tanpa pasangan lengkap**. Pada143pasangan:53win/90loss,
  net quote setelah modelnetwork **+$2,0237**. Itu bukan profit seluruh173entry atau receipts.
- Empatpasangan berurutan waktu bermasalah. Pada139pasangan berurutan: net **+$2,9200**.
  Pemisahan ini diagnostik, bukan filter yang menghapus trade buruk secara diam-diam.
- Network2× membuat139pasangan menjadi **−$3,8501**; tambahan haircut1% padaoutputsell
  menjadi **−$4,1270**. Sensitivitas ini bukan replay latency atau fee on-chain teramati.
- Mengurangi kontribusi3winner terbesar menghasilkan **−$4,2990** pada139pasangan.
  Ini diagnosis ketergantungan winner, bukan aturan yang tahu winner di muka.
- Known orderedquote30September−$0,9319;1Oktober+$3,8519. Hanya2hari, exposure berbeda
  dari AGY adaptive. Tidak cukup untuk menyatakan outperform atau formula stabil.

Laporan `reports/codex-stored-quote-diagnostic.json` mempertahankan seluruh denominator dan
baris bermasalah. Stake-only downside proxy untuk quote hilang/urutan takvalid dicatat,
tetapi bukan realized loss ataupun bound biaya lengkap (network/retry/rent belum diketahui).
Kesimpulan tetap belum ada pemenang. Arah riset berikut yang masuk akal adalah menguji
entry independent berbasis aggressive-safe dengan model eksekusi sama di raw tersimpan,
bukan terus mengubah sell pada89opportunity AGY atau menaikkan stake untuk menutup biaya.
Tahap independent tersebut **belum diimplementasikan**; tidak boleh menyebut hybrid lane
sudah profitable dari audit quote ini. Implementasi baru tetap terpisah dari AGY.

## V22 — independent Safe Context: sudah diimplementasikan dan diuji

Pembaruan ini melaksanakan arah independent yang sebelumnya belum dikerjakan di atas.
[Rencana/formula lengkap](PLAN_CODEX_SAFE_CONTEXT_V22.md) menjelaskan modeWAIT/SCALP/RUNNER/DEFEND,
konfirmasi mode1s/distincttick, profitfloor monoton, bataswaktu15/45s dan hardnet−6%.
Sinyal buy berasal dari fungsi aggressive-safe actual dengan shared data-quality adapter,
bukan turunan peluang AGY saja. Ini tidak mereplikasi seluruhservice/early-holder/reentry.
AGY, collector, config dan layananlive tidak diubah.

Tersedia28sumber/14.660detail pada1Oktober00WIB–4Oktober20:30WIB:12.869withticks,
57akhir sesi inferred. Dua pilihan DIRECT/CONFIRM500ms dibekukan sebelum replay.
TRAIN dipakai memilihprimary SAFE_CONTEXT_500; AUDIT dan storedLater hanya dievaluasi
sesudahselectionfile tersimpan. Semua periodehistoris pernah dipelajari, bukan holdoutbaru.
Caseinput/record per-source disimpan dan dihash. Native TRAIN54/−$8,0540 dan AUDIT29/−$5,4540
persis cocok studi lama; jadi perbedaan hasil bukan karena AGY diubah.

| V22 primary | Entry | Win/loss | Unknown | Known net base | Conservative bound |
|---|---:|---:|---:|---:|---:|
| TRAIN | 62 | 10/41 | 11 | −$20,2248 | −$75,4947 |
| AUDIT | 19 | 3/12 | 4 | −$2,2936 | −$22,3917 |
| storedLater4Okt10:00–20:30WIB | 11 | 4/5;1buyfailed | 1 | −$0,5792 | −$5,6039 |

Cumulative92independent entry:17win/58loss,16unknown,1buyfailed;known−$23,0975,
bound−$103,4902. Delay2s known−$16,2126 dan fee2%known−$33,1324: semuanya negatif.
Portfolio base hanya4attempt/3loss−$1,6651, lalu unresolved memblokir posisi; tidak mengklaim
jumlah event−$23,0975 sebagai hasil executable portfolio. SAFE_NATIVE pada cohort entry
independen185TRAIN/60AUDIT/30later juga negatif dan ber-unknown tinggi. Pada storedLater,
AGY native10entry/9closed menghasilkan5win/4loss,+$2,8316, sedangkanCodex tetapnegatif.
Periode later ini lebih panjang daripada catch-up6opportunityv17, jangan mencampurangkanya.

Same-buy safe-native comparator mengisolasi efekexit: audit base improvementknown+$1,0263,
tetapi kedua exit tetapnetnegatif; delaystress memperburuk unknown/bound. Perbaikan relatif
terbatas bukan formula untung. Tidak memakai ranking audit untuk menggantiprimary TRAIN.

Semua92entryCodex bermodeSCALP;43perubahanmode post-fill, tetapi tidak adaRUNNERtercapai.
ModeWAIT/SCALP/DEFEND muncul pada state tersimpan; unit-testRUNNER bukan buktiprofit pasar.
Sinyal mencakup23jamWIB, jam03tidak teramati; sampel4hari tidak membuktikan segala waktu.
262tes/typecheck/diffcheck lulus. Hasil `reports/codex-safe-context-v22-summary.json`,
coverage `reports/codex-safe-context-v22-coverage.json`. Status **TRAINING_REJECTED / NO LIVE**.
