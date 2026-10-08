# Codex Flow Wave v2 — audit seluruh arsip dan formula penelitian

Tanggal: 3 Oktober 2026. Batas data: **3 Oktober 2026 pukul 12:00 WIB / 05:00 UTC**. Data yang masuk sesudah batas ini tidak dipakai untuk menilai formula.

**Keputusan: belum ada formula yang lolos validasi. Jangan mengaktifkan versi Codex untuk uang nyata berdasarkan hasil ini.** Modul penelitian terpisah sudah tersedia; tidak dihubungkan ke collector, dashboard, wallet, atau AutoBuy. Implementasi Gemini/AGY tidak diedit.

## 1. Data yang benar-benar diperiksa

| Sumber | Cakupan |
|---|---:|
| Sesi detail dari folder + arsip ZIP unik | 21.382 |
| Baris trade yang dibaca pada sumber detail | 2.317.052 |
| Studi tick terpisah | 8 studi, 1.116 sesi, 497.212 baris trade |
| Posisi buy historis setelah deduplikasi | 4.610 |
| Posisi dengan pasangan quote buy/sell exact quantity | 3.772 |
| Percobaan live dalam ledger setelah deduplikasi | 65 dari 93 baris |
| Quote lengkap dari payload respons mentah | 48.912 pada 1.020 mint |

Folder saja memuat 20.040 detail; ZIP September 24 menambah 1.342. ZIP dibaca streaming, tidak diekstrak menjadi salinan besar. Studi tick tidak dipaksa masuk replay v2 karena tidak mempunyai seluruh bukti holder/dev yang diwajibkan. Baris trade antar sumber bukan jumlah transaksi on-chain unik global. File turunan/dashboard tidak dihitung sebagai observasi pasar baru.

Untuk **2 Oktober 00:00–24:00 WIB**: 3.540 kunjungan detail, 3.416 mint; 3.226 kunjungan mempunyai tick. Hanya 1.062 kunjungan tercatat berlangsung minimal 90 detik; 2.436 dihentikan dini karena `OBSERVATION_ABORTED_DUMP`. Buffer 90 detik bukan jaminan semua token memiliki rekaman penuh sampai 90 detik, apalagi setelah posisi hipotetis baru dibuka.

## 2. Lane lama: mana yang lebih baik?

Berikut rata-rata return **SOL dari pasangan quote**, bukan actual fill. Kolom kanan menambahkan asumsi biaya jaringan 0,000205 SOL per sisi ke jumlah SOL masuk/keluar; tidak memotong lagi fee platform/DEX yang sudah tercermin dalam output quote. Stake mengikuti arsip, tidak disamakan antar-lane.

| Lane | Pasangan | Mean quote SOL | Setelah asumsi jaringan |
|---|---:|---:|---:|
| Wave | 131 | +2,12% | −7,28% |
| Momentum V2 | 425 | +1,61% | −4,64% |
| Safe | 301 | +1,04% | −3,67% |
| Momentum V3 | 1.383 | +0,75% | −4,73% |
| Wide | 183 | +0,53% | −4,75% |
| R5 | 231 | +0,13% | −6,93% |
| Swing 100k | 170 | −0,11% | −9,42% |
| Optimal | 112 | −0,31% | −5,02% |
| Control | 634 | −0,59% | −5,69% |
| V3 exit-confirmed | 82 | −3,35% | −5,71% |
| V3-v8 | 120 | −4,29% | −6,64% |

Aggressive-flow memiliki 43 entry tanpa pasangan quote sehingga tidak dapat disejajarkan pada tabel ini. Semua pasangan Wave memakai stake $0,50; lane lain mencampur $0,25/$0,50/$2/$5. **Wave memimpin mean quote pada sampel ini, bukan pemenang profit all-in.** Safe paling sedikit negatif dalam skenario jaringan tabel, tetapi perbedaan stake, token, periode, dan versi implementasi membuat ranking mentah tidak adil.

Perbandingan token/periode berpasangan dalam audit awal: V2 vs V3 hanya 198 pasangan (mean quote USD +2,61% vs +2,03%); Wave vs Swing hanya 27 (+2,72% vs +1,47%). Ini pemeriksaan tambahan, bukan bukti superioritas universal.

Ada 9 dari 131 pasangan Wave dengan respons quote buy datang **sesudah** sinyal exit paper. Contoh CC: paper buy → exit hanya 314 ms; quote buy baru diterima 599 ms setelah buy. Socket +3,54% berubah menjadi return quote sekitar −2,59%, sebelum asumsi jaringan. Jangan menyamakan keputusan paper tersebut dengan urutan transaksi yang sudah terkonfirmasi.

Ledger live juga belum lengkap sebagai laporan all-in: V3 mencatat 34 `BUY_FAILED` dari 44 percobaan; V2 mempunyai posisi/status yang belum seluruhnya terkonfirmasi. Nilai wallet buy/sell dalam snapshot bukan rekonsiliasi seluruh biaya chain. Tidak menganggap `CLOSED` atau hash tersedia saja sebagai bukti fill dan fee lengkap.

## 3. Koreksi penting dari payload jaringan mentah

Ringkasan `quoteSummary()` membuang sebagian informasi. Payload mentah ternyata menyimpan:

- Minimum output pada seluruh 48.912 quote, juga blockhash dan last-valid block height.
- `contextSlot`: **0 quote**. Block height dan slot bukan field yang sama.
- `prioritizationFeeLamports`: 100.000 pada seluruh quote yang diperiksa.
- `sol_cost`: median 1.095.880 lamport, p90 4.072.760. Arti/komponennya belum direkonsiliasi dengan receipt; **bukan langsung dianggap final network fee**. Bisa mencakup komponen selain biaya yang benar-benar hangus.
- Fee per-hop, serta 206 respons pool-fee; median `fee_ratio` 1,25%. Fee route dapat sudah tercermin dalam output; jangan dihitung dua kali.
- 208 respons swap setelah deduplikasi kategori/waktu/body, 129 membawa hash. Poll/status bukan 129 posisi unik dan bukan otomatis 129 transaksi sukses.

Pada 783 sinyal v2, hanya **60** memiliki quote buy yang sudah diterima dalam 2 detik sebelumnya; 53 berukuran sekitar $0,50, nol sekitar $10. Ini belum membuktikan adanya pasangan sell untuk jumlah token hasil buy hipotetis yang tepat. Quote sesudah sinyal tidak diubah menjadi informasi yang seolah-olah sudah diketahui saat entry.

Dengan demikian: pernyataan “minimum output tidak ada” hanya benar untuk ringkasan terdahulu, **tidak benar untuk seluruh arsip mentah**. Namun temuan ini belum mengubah replay socket menjadi replay swap autentik pada seluruh universe.

## 4. Eksperimen Codex yang dibekukan

ID modul: `codex-flow-wave-v2`. Enam profil entry, tiga profil exit, 45 pilihan satu filter tambahan = **810 kombinasi**. Tidak menumpuk banyak filter sampai satu loss menghilang.

- Pemilihan: sampai 30 September WIB; minimum 30 posisi selesai dan 3 hari.
- Pemeriksaan berikutnya: 1–2 Oktober WIB.
- Pemeriksaan paling akhir: 3 Oktober 00:00–12:00 WIB.
- Mint yang sudah muncul pada bagian sebelumnya dikeluarkan dari bagian berikutnya. Sinyal 180 detik terakhir tiap bagian dikeluarkan.
- Satu setup pertama per detail/profil; maksimal satu percobaan per mint per 24 jam. Jangan mencari titik entry lain setelah mengetahui setup pertama rugi.
- Seleksi mempertimbangkan batas bawah bootstrap blok 6 jam, profit factor, dan hasil unresolved. Semua kandidat gagal syarat training. Kandidat dengan ranking tertinggi tetap dilaporkan untuk diagnosis, bukan disahkan.

Peringkat training tertinggi pada skenario toleransi konfigurasi adalah `broad_control/scalp/buyUsd_min_500`, baik untuk $0,50 maupun $10. Konfigurasi project kemudian terbaca memakai **$5**; skenario $5 memakai formula dan sinyal yang sama, tanpa seleksi ulang. Snapshot saat itu: AutoBuy `false`, buy slippage 9%, sell 14%. Tidak ada pengubahan konfigurasi oleh audit ini.

### Hasil seluruh sinyal independen

| Stake per entry | Sinyal | Win | Loss | Buy gagal | Unknown | Jumlah PnL model yang diketahui |
|---|---:|---:|---:|---:|---:|---:|
| $0,50 | 205 | 23 | 154 | 8 | 20 | −$10,35 |
| $5 | 205 | 49 | 129 | 8 | 19 | −$29,73 |
| $10, hanya sensitivitas | 205 | 49 | 129 | 8 | 19 | −$50,62 |

**Ini event-study: setiap sinyal dinilai terpisah, bukan portofolio yang bisa diperdagangkan bersamaan.** PnL diketahui memasukkan biaya model buy gagal, tetapi tidak menjadikan unknown sebagai nol rugi. Batas konservatif yang memperlakukan seluruh modal unknown sebagai hilang menghasilkan −$125,20 untuk $5; itu skenario risiko, bukan kerugian terealisasi yang diklaim terjadi.

Pada stake $5:

| Bagian | Sinyal | Win / loss selesai | Gagal / unknown | PnL model diketahui |
|---|---:|---:|---:|---:|
| Training | 72 | 14 / 47 | 5 / 6 | −$15,35 |
| Validasi 1–2 Oktober | 101 | 23 / 65 | 3 / 10 | −$12,77 |
| Test 3 Oktober pagi | 32 | 12 / 17 | 0 / 3 | −$1,61 |

Khusus **2 Oktober**, dari 62 sinyal: **14 win, 40 loss, 3 buy gagal, 5 unknown**; PnL model diketahui −$9,38. Ini hasil v2 pada $5, bukan mengganti hasil v1 terdahulu pada $0,50.

Delay 2s pada $5: 51 win/111 loss, 12 buy gagal, **31 unknown**, PnL diketahui −$25,71. Angka yang lebih sedikit negatif tidak berarti lebih baik karena exposure unknown meningkat. Stress tambahan fee 1% per sisi: 38 win/138 loss, 8 gagal/21 unknown, PnL diketahui −$42,53.

### Simulasi satu posisi aktif: lebih dekat ke kendala operasional

Satu posisi/pending saja, cooldown 15 menit setelah tiga loss berurutan, batas rugi harian dua kali stake. **Unknown memblokir seluruh entry selanjutnya** sampai rekonsiliasi, bukan dihapus dari ledger.

Pada rangkaian seluruh sejarah dengan $5, simulasi berhenti setelah 14 percobaan: **5 win, 7 loss, 1 buy gagal, 1 unresolved**. PnL model yang sudah diketahui −$1,37; 190 sinyal berikutnya diblokir oleh unresolved. Ini alasan 205 event-study tidak boleh dijual sebagai 205 trade portofolio yang pasti bisa dilakukan.

## 5. Formula kandidat yang benar-benar diuji

Ini **kontrol penelitian yang belum lolos**, bukan formula “super optimal” yang terbukti.

Entry harus memenuhi semuanya:

1. Histori tape ≥7s, anchor return 5s valid, harga terakhir diterima ≤750 ms; entry hanya dalam 60s pertama detail.
2. Umur token ≥15s, MC inferensi $5.500–$100.000, holder ≥40. Top1 ≤8%, Top5 ≤30%, dev ≤2,5%. Holder/count fresh ≤30s; dev ≤60s. Data tidak tersedia berarti tolak, bukan nol kepemilikan.
3. Return5s +0,25…20%, return2s positif, drawdown5s ≤2,5%, drawdown10s ≤15%.
4. Buy share5s dan 2s ≥60%; ≥5 trade, ≥3 buyer unik; volume buy5s **≥$500**; satu wallet ≤50% buy volume.
5. Tidak ada dev sell ≥$25 pada 30s terakhir atau penjualan besar yang diketahui dari snapshot **sebelum** transaksi jual.
6. Konfirmasi dua tick berbeda, berjarak 150–500 ms, deviasi harga ≤2%. Pengulangan tick tidak dihitung sebagai bukti baru.

Valuasi model dalam SOL:

```text
I = stakeUSD / SOLUSD
Rnet(P) = 100 × [(I × (1 − f)^2 × P/Pbuy − Fsell) / (I + Fbuy) − 1]
f = 1% per sisi; Fbuy = Fsell = 0,000205 SOL dalam skenario utama
riskFloor = max(−20%, Rnet(harga buy) − 4 poin persentase)
```

Contoh SOL $120: stake $0,50 langsung menanggung −11,28% round-trip model pada harga tetap, sehingga membutuhkan kenaikan harga **12,07%** untuk impas. Stake $5: −2,96% pada harga tetap dan kenaikan **3,03%** untuk impas. Ini belum menambahkan biaya venue/rent yang tidak diketahui. Membesarkan stake mengurangi persentase fixed cost, tetapi **tidak menciptakan edge**; skenario $5/$10 juga negatif.

Exit scalp yang diuji:

- Darurat jika penjualan besar yang diketahui disertai harga 2s melemah atau dev sell ≥$25/30s; atau harga jatuh ≥8%/1s. Ini indikator risiko, bukan label rugpull terkonfirmasi.
- Stop jika harga ≤−4% dari buy atau return net melewati `riskFloor`.
- Flow buy5s ≤35%, sell5s ≥$150, ≥3 seller, return2s negatif: konfirmasi dua tick berbeda dalam 500ms.
- Peak net +4% mengaktifkan floor +1%; peak +8% mengaktifkan `max(floorLama, 2, (100+peakNet)×0,96−100)`. Floor tidak turun.
- Net ≥+8% dijual ketika flow melemah; stagnasi 12s jika peak net <2% dan flow lemah; batas hold 30s.
- Gap harga 10s adalah alasan keluar/unknown, **bukan bukti koneksi socket putus**.

Fill model memakai tick fresh pertama setelah delay 1s atau 2s, tambahan tunggu maksimum 2s, maksimal tiga percobaan sell. Gap harga tidak dijepit ke harga stop. Buy slippage 9% berarti batas harga `Pquote/(1−0,09)`, bukan memotong otomatis 9% dari hasil; sell 14% membatasi minimum output. Sebanyak 9.396 replay parity checks memastikan penambahan skenario toleransi tidak mengubah model awal 2%/5%.

## 6. Rugpull: batas yang tidak bisa dihilangkan oleh formula

Pada audit v1 satu hari, ada 484 kunjungan/483 mint dengan fast-crash ≥30% dari puncak 10s; baseline v1 tidak memberi sinyal sebelum crash tersebut. Namun filter banyak menolak karena bukti tidak lengkap. Itu **bukan** 100% deteksi rugpull, bukan recall terhadap semua rug, dan tidak dipindahkan menjadi klaim performa v2.

V2 masih mengalami model loss −32,25% pada Commish walaupun exit `DUMP_OR_FLASH`. Harga sell setelah delay/retry jauh di bawah harga buy. Penjualan dev, konsentrasi holder, serta dominasi satu wallet membantu menyaring risiko tetapi tidak mengungkap seluruh cluster pengendali, authority, perubahan pool, atau sell yang benar-benar mustahil. Stop adalah permintaan keluar, bukan jaminan likuiditas tersedia.

## 7. Satu rencana lanjutan: bukti eksekusi dahulu, evaluasi formula sesudahnya

Tetap gunakan v2 sebagai **shadow-control**, tidak sebagai sinyal live. Jangan menambah filter berdasarkan test yang sudah dilihat lalu menyebutnya holdout baru.

1. Runner Codex terpisah: rekam status koneksi/heartbeat, urutan receipt, snapshot holder/dev sebelum keputusan, mint authority/token extensions, dan bukti pool/reserve. Jangan mengubah runner Gemini.
2. Ketika setup hampir valid, ambil quote buy pada stake target dan reverse sell untuk **jumlah token hasil quote itu**, dengan request/receipt time, min-output, blockhash/validity, slot jika provider menyediakan, price impact, serta struktur biaya. Sell simulation/structural check gagal atau tidak diketahui → tidak ada izin live.
3. Hitung `netLiquidation = 100 × (sellNetSOL / buyAllInSOL − 1)` dari jumlah quote yang sudah direkonsiliasi. Jangan menebak biaya tambahan dari `platformFee: 0`, `sol_cost`, atau socket. Tambahkan rent sebagai kebutuhan kas dan pisahkan biaya refundable dari biaya hangus.
4. Pertahankan capture sampai posisi benar-benar terselesaikan walaupun tab detail berganti/observasi awal berakhir. Pending/ambiguous signature memblokir entry; sebelum retry, pastikan transaksi lama belum sukses. Tidak boleh menciptakan fill pada akhir file.
5. Bekukan formula dan ukur forward-paper pada data baru: model pembanding yang sama, seluruh sinyal/rejection disimpan, biaya/latency aktual, hasil unknown dilaporkan. Baru pertimbangkan perubahan formula bila data memberi bukti out-of-sample positif. Penelitian ini belum memenuhi syarat itu.

Ini rencana pengembangan, bukan klaim fitur collector tersebut sudah diimplementasikan. Tidak ada transaksi atau perubahan layanan yang dijalankan oleh script audit/replay.

## 8. File, reproduksi, dan verifikasi

Mulai dari ringkasan kecil:

- `reports/codex-v2-current-stake-summary.json` — skenario $5 dan simulasi satu posisi.
- `reports/codex-v2-configured-selection-summary.json` — seleksi 810 varian, $0,50/$10, waktu validasi.
- `reports/codex-lane-execution-audit.json` — semua lane, quote vs asumsi jaringan.
- `reports/codex-raw-route-audit.json` — metadata/angka quote yang disanitasi, tanpa URL, header, atau raw transaction message.

Implementasi terpisah: `src/codex-flow-wave-v2.ts`, `scripts/codex-flow-wave-engine.mjs`, `scripts/codex-history-source.mjs`. Hasil besar dan ledger tetap di disk. Fingerprint replay dasar adalah fingerprint kode/konfigurasi cutoff, bukan hash kriptografis seluruh 20 GB arsip; jangan menyebutnya bukti data immutable.

```sh
# Baca saja; output hanya laporan lokal. Jangan menjalankan collector/live sebagai bagian audit.
node scripts/audit-lane-plan.mjs --all --cutoff=2026-10-03T05:00:00Z
node --import tsx scripts/replay-codex-all-history.mjs
node --import tsx scripts/replay-codex-configured-execution.mjs
node --import tsx scripts/select-codex-flow-wave.mjs --configured
node --import tsx scripts/replay-codex-current-stake.mjs
node scripts/audit-codex-raw-routes.mjs
node scripts/audit-codex-lane-execution.mjs
npm test
npm run typecheck
```

`replay-codex-current-stake.mjs` membaca stake/slippage konfigurasi saat dijalankan; bila konfigurasi berubah, hasilnya memang skenario berbeda. Versi laporan ini mengambil $5/9%/14%. Harga SOL tidak tersedia/fresh pada 79 dari 783 sinyal sehingga dipakai asumsi $120 yang ditandai; bukan harga historis yang diklaim teramati.

Verifikasi akhir: **139/139 tes lulus**, `npm run typecheck` lulus. Tes tambahan mencakup penyaringan quote masa depan/stale, tidak membocorkan raw transaction message, pending/unknown yang memblokir entry, dan cooldown portofolio. File dashboard yang berubah otomatis tidak diedit atau dikembalikan oleh audit ini.

Rujukan eksternal untuk pemisahan komponen biaya: [GMGN fees](https://docs.gmgn.ai/index/gmgn-fees-settings), [Solana transaction fees](https://solana.com/docs/core/fees). Untuk membedakan ketiadaan trade dari status koneksi: [WebSocket readyState](https://developer.mozilla.org/en-US/docs/Web/API/WebSocket/readyState). Angka empiris di atas berasal dari arsip lokal, bukan sumber eksternal ini.
