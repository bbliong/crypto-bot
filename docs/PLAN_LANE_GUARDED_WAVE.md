# Plan 9 — Guarded Wave v1

Tanggal analisis: 3 Oktober 2026. Lane usulan: `guarded-wave-v1`.

Status: **rencana implementasi dan pengujian paper; belum menjadi lane aktif**. Analisis membaca `PROJECT_SUMMARY.md`, kode aktual, SQLite, dan log asli. Tidak mengubah konfigurasi AutoBuy, service, atau strategi berjalan.

Pembaruan hasil replay: versi Codex dibuat terpisah dari implementasi Gemini/AGY di `src/codex-guarded-wave.ts`. Replay 2 Oktober dan pengujian 18 formula **belum menghasilkan kandidat tervalidasi**; lihat [laporan Codex](CODEX_GUARDED_WAVE_RESEARCH.md). Angka desain di dokumen ini tetap hipotesis, bukan bukti profit.

## 1. Keputusan utama

Belum ada lane yang terbukti paling baik untuk **profit live setelah seluruh biaya**. Untuk pengembangan, gunakan disiplin entry Momentum V2, filter flow/distribusi yang punya dukungan historis, dan pengelolaan runner dari Wave. Perbaiki validitas eksekusi sebelum mencari tambahan persentase profit.

- **Wave paling menjanjikan pada periode pendek yang tersedia**, tetapi quote tersimpan kadang sangat berbeda dari harga saat crash. Hasilnya belum cukup untuk memilihnya sebagai lane live terbaik.
- **V2 menjadi benchmark utama**: sampelnya lebih besar, hasil quote positif, dan lebih baik daripada V3 pada entry yang sama. Tetap sensitif terhadap delay dan biaya.
- **Optimal bukan pilihan utama**: return quote rata-ratanya negatif. Nama lane dan rekomendasi dalam ringkasan/dashboard tidak membuktikan keunggulan.
- Membuat stop lebih lebar saja tidak menyelesaikan masalah. Demikian pula menumpuk filter ketat tidak otomatis memperbaiki hasil.

Tujuan lane baru: expectancy bersih positif, kerugian ekstrem terkendali, dan hasil dapat diaudit per posisi. Win rate dan jumlah trade adalah metrik pendamping. Angka parameter di bagian desain adalah **hipotesis awal yang dibekukan untuk diuji**, bukan optimum yang sudah terbukti.

## 2. Cakupan dan perbandingan lane

Cutoff: **3 Oktober 2026, 06:00 WIB / 2 Oktober 2026, 23:00 UTC**, akhir sesi lengkap. Sesi yang masih berjalan tidak dicampur. Membaca 54 file riwayat simulasi, memperoleh 3.083 posisi unik yang sudah tutup, dan mencocokkan 3.000 pasangan quote. Sebanyak 83 posisi tidak memiliki pasangan quote lengkap; return-nya tetap UNKNOWN.

Dedup memakai `positionId`, termasuk salinan arsip sesi. Quote wajib memiliki posisi yang sama, waktu keputusan yang cocok, dan jumlah input token sell persis sama dengan output buy. Tidak menggunakan fallback antar-lane/antar-entry token yang sama.

| Lane | Posisi tutup | Pasangan quote | Win quote | Rata-rata quote/trade | Profit factor | Kerugian quote terburuk |
|---|---:|---:|---:|---:|---:|---:|
| Wave | 79 | 78 | 51,28% | +3,752% | 2,70 | −11,43%* |
| V2 | 367 | 362 | 45,03% | +1,545% | 1,56 | −31,50% |
| Safe | 322 | 290 | 37,24% | +1,164% | 1,37 | −42,86% |
| Swing 100k | 98 | 95 | 40,00% | +1,026% | 1,43 | −35,48% |
| Wide | 168 | 167 | 37,72% | +0,822% | 1,23 | −63,09% |
| R5 Band | 165 | 165 | 40,61% | +0,804% | 1,31 | −22,75% |
| V3 | 1.259 | 1.226 | 39,89% | +0,714% | 1,20 | −89,95% |
| Optimal | 101 | 101 | 32,67% | −0,269% | 0,92 | −62,96% |
| Control | 524 | 516 | 34,69% | −0,268% | 0,95 | −86,84% |

Return quote = `sell.amountOutUsd / buy.amountInUsd - 1`. Ini **bukan fill on-chain atau return all-in**. Biaya yang belum masuk amount tersebut masih harus dihitung. Profit factor dihitung dari return per trade dengan bobot stake sama, bukan profit portofolio. Stake historis berubah. Periode aktif dan versi aturan antar-lane juga berbeda.

*Wave memiliki kerugian socket sampai −42,14%; quote −11,43% bukan batas risiko sebenarnya.*

Wave baru muncul 2 Oktober pukul 22:29 WIB: hanya sekitar 7,5 jam hingga cutoff, 45 mint dengan pasangan quote, dan tiga slot sesi termasuk satu slot parsial. Jika hanya mengambil entry pertama per mint, rata-rata quote +3,795% pada 45 pasangan. Pada periode bersama tersebut, Wide menghasilkan +8,767% tetapi hanya 17 pasangan, sedangkan V2 +2,787% pada 71 pasangan. Jadi ranking tidak boleh hanya membandingkan rata-rata lintas periode.

Bootstrap per mint menghasilkan interval rata-rata quote 95% Wave sekitar +1,33..+6,74% dan V2 +0,50..+2,58%. Interval ini tidak mengoreksi bias quote, perubahan rezim, korelasi antar-token dalam sesi, atau biaya eksekusi.

Perbandingan entry identik:

- Safe vs Wide, 115 pasangan: +0,376% vs +0,003%. Stop −6% tidak otomatis lebih baik daripada −3%.
- V2 vs V3, 169 pasangan: +2,365% vs +1,891%. Pelonggaran V3 belum menunjukkan keuntungan pada kelompok ini.
- Quote tiap lane diambil pada waktu berbeda; selisih tersebut mencampur efek strategi dengan efek waktu request.

## 3. Temuan yang menentukan desain

### A. Pelaporan dan sumber data

1. Dashboard mengisi `realReturn` dengan `socketReturn - 3.5` ketika quote kurang lengkap. Pemilihan sell/quote juga dapat jatuh ke pencocokan mint atau lane lain. Ini tidak boleh menjadi label real/executed. Lihat `scripts/serve-aggressive-dashboard-agy.mjs`, sekitar baris 887–943.
2. Dari 93 baris `real_trades`, tersisa 65 percobaan unik setelah dedup hash/order/waktu; ada 28 baris duplikat. `status=CLOSED` tidak selalu berarti `sell_ok=1`.
3. Sampel dengan buy/sell sukses dan snapshot pendapatan: Safe 5, V2 11, V3 6. Masih ada 2 buy V2 dan 3 buy V3 tanpa sell sukses pada catatan audit. Snapshot gross PnL bisa terlambat atau kumulatif. Contoh Gentaro: sell hash ada tetapi pendapatan snapshot nol, sehingga label −100% belum boleh dianggap rugpull terkonfirmasi.
4. `strictHolderPreBuy` dihitung dan dicatat, tetapi tidak disertakan dalam kondisi `aggressive*BuyAllowed`. Sebanyak 38 dari 79 entry Wave memiliki gate strict gagal; ini bukan otomatis 38 token scam. Lihat `src/research-collector.ts`, sekitar baris 2531 dan 2600–2652.
5. Missing MC dapat lolos (`candidateMC === null`). Persentase dev dapat bermula dari nol atau data terbatas. UNKNOWN tidak boleh diartikan aman. Ownership dari net trade yang baru diamati tidak setara dengan distribusi supply penuh.
6. Aturan aktual berbeda dari ringkasan: Safe/Optimal/Wide memakai buy share 95%, runner mulai +10%, trail 7% pada kode sekarang. Manifest lama menunjukkan runner mulai +8%. V2 dalam mode pembanding agresif tidak diberi gate MC $5.500–$15.000 yang sama. `PROJECT_SUMMARY.md` membantu orientasi, bukan sumber kebenaran performa.

### B. Socket dan swap

- Jeda event sampai diterima yang tercatat saat entry: median 1.140 ms, p95 1.696 ms. Timestamp event dibulatkan ke detik dan entry sudah difilter; ini bukan pengukuran murni latensi jaringan. Klaim socket selalu <50 ms tidak terbukti dari log ini.
- Request buy quote: median 402 ms, p95 1.929 ms. Poll sell: median 245 ms, p95 1.040 ms. Interval target 500 ms tidak menjamin data baru setiap 500 ms.
- 2.532 dari 3.000 sell quote menggunakan cache. Usia cache median 300 ms, p95 983 ms; usia respons tidak membuktikan slot pool atau harga router masih mutakhir.
- NIKA / Wave: socket −38,67%, quote cache −6,44%; cache berusia 159 ms. BLACKLOCK / Wave: socket −42,14%, quote cache −6,53%; cache 367 ms. Kedua selisih ini cukup untuk menggugurkan klaim bahwa return quote pasti dapat direalisasikan.
- `quoteSummary()` tidak menyimpan seluruh `contextSlot`, minimum output, atau rincian biaya. `priceImpactPct=0` saja tidak cukup membuktikan kualitas rute.
- Quote riset menggunakan `is_anti_mev=false` dan fee tetap, sementara pengiriman order membaca pengaturan eksekusi. Identitas quote dan order harus mencakup parameter ini.

Replay sensitivitas membaca lebih dari 1,3 juta baris trade socket dan mempertahankan 355.740 tick unik relevan sebelum cutoff. Pada 255 trade V2 dengan data lanjutan, tambahan delay minimum 1 detik pada buy dan sell mengubah rata-rata socket dari +4,204% menjadi +0,570%. Pada 221 trade Safe, +1,775% menjadi −1,436%. Replay memakai tick fresh pertama setelah delay, dengan toleransi pencarian tambahan maksimal 2 detik. Ini proxy berbasis tick, bukan hasil swap; trade tanpa data lanjutan tidak diisi secara fiktif.

### C. Biaya dapat menghabiskan seluruh edge

Konfigurasi saat audit: stake $0,50, priority 0,0001 SOL, tip 0,0001 SOL, buy slippage 9%, sell 14%, AutoBuy nonaktif. Slippage adalah batas toleransi; bukan potongan biaya pasti.

Ilustrasi pada SOL $120, apabila priority+tip benar-benar dibebankan masing-masing per sisi: `2 × (0,0001 + 0,0001) × $120 = $0,048`, atau **9,6% dari stake $0,50**, sebelum komponen lain. Ini ilustrasi konfigurasi, bukan hasil rekonsiliasi fee transaksi. Jangan menjumlahkan field `fee` lagi bila sudah mencakup priority/tip, atau memotong ulang fee platform yang sudah masuk quote.

Stress tambahan biaya 3 poin persentase mengubah rata-rata quote V2 menjadi −1,455%, Safe −1,836%, dan Wave +0,752%. Dengan 5 poin, Wave juga negatif. Lane baru harus boleh memutuskan **SKIP karena tidak ekonomis**. Jangan otomatis menaikkan stake pengguna untuk menutup masalah biaya.

### D. Kapan masuk dan ciri risiko

Filter eksploratif pada entry V2 yang sudah terjadi: buy share 5s ≥60%, buy share 20s ≥65%, Top1 ≤8%, dev ≤2,5%. Dengan exit V2 tetap, 149 pasangan menghasilkan +2,471% rata-rata dibanding baseline +1,545%. Pada pembagian waktu 2 Oktober 21:00 WIB, bagian awal +2,192%/120 trade dan bagian akhir +3,626%/29 trade. Semua bagian sudah diperiksa; ini bukan holdout yang belum dilihat, dan belum merupakan backtest lengkap lane baru.

Pola yang layak dipakai:

| Bukti sebelum entry | Interpretasi dan tindakan |
|---|---|
| Flow beli bertahan pada 5s dan 20s, harga/slope naik, buyer tersebar | Momentum lebih layak diamati daripada satu transaksi besar. Konfirmasi ulang setelah quote siap. |
| Satu buyer/kelompok dompet mendominasi atau transaksi bolak-balik | Risiko flow buatan. Wallet berbeda belum tentu pemilik berbeda. |
| Control dengan Top1 >20%: 29 quote, rata-rata −7,434%, 5 loss ≤−20% | Konsentrasi ekstrem memberi alasan kuat menolak; bukan bukti bahwa Top1 rendah pasti aman. |
| Control dengan dev >5%: 94 quote, rata-rata −1,579% | Dev besar menambah risiko, tetapi dev=0 pada data kosong/terlambat bukan jaminan. |
| OCTO: dev tercatat 0%, Top1 1,90%, tetapi Optimal/Wide sekitar −63% | Distribusi snapshot yang tampak baik tidak menangkap semua cluster/dump dan kegagalan eksekusi. |
| ZKAPI/V3: buy share 5s 58%, flow20 52,77%, strict holder gagal; quote −89,95% | Hindari masuk ketika flow lemah, bukti holder tidak lengkap, dan penjualan terlambat. |
| Reserve pool turun, otoritas berbahaya, sell tidak dapat disimulasikan | Risiko struktural; lebih kuat daripada skor momentum. Perlu bukti on-chain/protokol yang belum lengkap pada dataset. |

Pada 94 stop Safe yang masih terpantau 20 detik sesudah exit, 40 sempat pulih ke +8% dari harga entry, tetapi 25 juga turun ke −20%. Kedua kejadian bisa mengenai token yang sama. Data ini mendukung membedakan pullback dan rusaknya flow, bukan menahan semua token yang turun.

Label historis harus memakai `FAST_CRASH`, `SELL_UNAVAILABLE`, `DATA_UNKNOWN`, atau `CONFIRMED_LIQUIDITY_REMOVAL` sesuai bukti. Jangan menyebut setiap loss besar sebagai rugpull yang telah terbukti. Akurasi prediksi rugpull belum dapat dihitung karena tidak tersedia label kejadian on-chain lengkap.

## 4. Spesifikasi satu lane baru

### Identitas dan batas desain

`id: guarded-wave-v1`, default `paper`, satu posisi aktif termasuk order BUY_PENDING, satu entry per mint per 24 jam. Tidak averaging down. Semua aturan memakai data yang sudah diterima pada saat keputusan. Tidak ada ATH masa depan, snapshot setelah entry, atau imputasi UNKNOWN menjadi nol.

### Tahap 1 — Token layak dan data siap

Hard gate; salah satu gagal berarti WAIT/REJECT, bukan pengurangan skor:

| Parameter awal | Aturan |
|---|---|
| MC | $10.000–$100.000, dihitung dari harga dan supply yang terverifikasi saat entry; bukan snapshot screening lama. |
| Riwayat | Minimal 20 detik observasi flow; umur token diketahui. Token <60 detik ditunda pada v1. |
| Holder | ≥100 holder; respons holder penuh dan data dev sukses, usia ≤10 detik; Top1 ≤8%, Top5 ≤25%, total dev ≤2,5%. LP/bonding-curve dikeluarkan berdasarkan identitas protokol terverifikasi. |
| Cluster | Ukur dompet terhubung melalui funding/transfer yang sudah tersedia; jika cluster terverifikasi menguasai >10% supply, tolak. Jika analisis belum tersedia, tetap UNKNOWN dan laporkan keterbatasannya; jangan mengklaim bebas cluster. |
| Mint | Program/supply/decimals valid, mint/freeze authority nonaktif. Pada v1, Token-2022 yang decoder extension-nya belum lengkap ditolak. |
| Pool | Pool dan mekanisme migrasi dikenali; likuiditas/reserve nyata terverifikasi, bukan sekadar angka virtual bonding curve. Bila sumber ini belum tersedia, tetap paper-only. |
| Sellability | Rute buy dan balik sell untuk kuantitas hasil buy tersedia. Simulasi transaksi sesuai kemampuan provider; quote saja tidak membuktikan token pasti dapat dijual. |
| Kesehatan data | Socket terakhir ≤750 ms sejak diterima; event age ≤2.000 ms; harga tidak bergerak mundur karena event lama; tidak ada gap/reconnect yang belum dipulihkan. |

Ambang umur, jumlah holder, Top5, cluster, freshness, dan MC ini adalah kebijakan risiko awal, belum optimum hasil backtest. Implementasi harus membedakan gate yang benar-benar terukur dengan yang belum tersedia.

### Tahap 2 — Momentum untuk buy

Semua syarat harus terpenuhi bersamaan:

- `return5s` +0,25% sampai +20%, slope positif, drawdown dari puncak 5s ≤2,5%.
- Minimal 5 trade dan 4 buyer unik/5s, inflow buy ≥$300, buyer terbesar ≤50% volume buy.
- Buy share 5s ≥60% dan buy share 20s ≥65%; window 20s harus benar-benar tercakup.
- Tidak ada dev dump terverifikasi ≥$25 dalam 30s terakhir; penjualan besar holder/cluster juga memicu penundaan. Threshold dev sell ini proteksi awal, bukan prediktor yang sudah tervalidasi.
- Candle berjalan tidak jatuh, harga pulih/stabil; candle yang belum ditutup tidak dianggap candle final.
- Siapkan quote dan data holder selama WATCH. Begitu sinyal valid, tunggu hanya bukti dua trade berbeda dengan jarak 150–500 ms sambil menyiapkan rute. Setelah respons quote datang, evaluasi ulang seluruh gate pada waktu sekarang. Batalkan setup yang berumur >1 detik atau harganya telah bergerak >2% dari harga saat setup.

Parameter baru tidak boleh diluluskan karena total skor masih tinggi ketika salah satu hard gate gagal. Kombinasi lengkap ini belum diuji sebagai lane baru; hasil filter V2 di atas tidak boleh dipakai sebagai estimasi performanya.

### Tahap 3 — Buy hanya jika layak dieksekusi

1. Quote berdasarkan wallet, stake, slippage, fee, protokol, dan route yang sama dengan order nanti. Simpan waktu request, waktu response, slot, expiry, jumlah input/output, minimum output, dan rincian fee.
2. Awal v1: usia receipt quote ≤750 ms, RTT ≤1.000 ms; price impact terverifikasi ≤1%; deviasi harga quote terhadap socket ≤2%. UNKNOWN impact/slot tidak diganti angka nol. Lonjakan pool/harga membatalkan cache walaupun usianya masih muda.
3. Estimasi round trip menggunakan kuantitas token yang benar. Semua biaya yang belum masuk route ditambahkan tepat satu kali. Expected immediate round-trip loss maksimal 3%; stress minimum-output/fee harus tetap dalam budget risiko awal 6%. Jika gagal, SKIP.
4. Untuk eksperimen paper, toleransi buy awal 1%, maksimum 2%; sell normal awal 2%, maksimum darurat 5%. Ini parameter uji yang menggantikan asumsi lama 9%/14% hanya pada lane baru setelah diimplementasikan. Jika toleransi ini menghasilkan kegagalan tinggi, lane gagal validasi; jangan melebar tanpa evaluasi ulang biaya/risiko.
5. Modal direservasi sejak BUY_PENDING. Buy baru dilarang bila ada order/posisi yang belum terselesaikan. Tentukan kuantitas aktual dari konfirmasi transaksi; sinyal buy atau klik sukses bukan fill.

Tetapkan stake sesuai pilihan pengguna dan batas modal, bukan dinaikkan otomatis. Usulan cap eksposur v1 adalah 1% ekuitas likuid per posisi untuk skenario kehilangan seluruh stake. Jika stake minimum yang ekonomis melampaui cap tersebut, hasil yang benar adalah tidak trading. Ekuitas harus diisi dan direkonsiliasi sebelum mode live.

### Tahap 4 — Sell berdasarkan hasil bersih yang bisa diharapkan

Definisikan dalam SOL agar tidak tercampur perubahan SOL/USD:

```text
C = SOL aktual untuk membeli + fee buy yang belum tercakup
V(t) = expected SOL sell untuk token aktual yang tersisa − fee sell yang belum tercakup
R_net(t) = 100 × (V(t) / C − 1)
```

Rent akun token dilacak terpisah sebagai modal terkunci sampai benar-benar direfund. PnL realised dihitung dari saldo transaksi dan fee ledger; tidak mencampur akumulasi wallet token dari siklus lain. Simpan return expected, minimum-output, dan realised sebagai tiga field berbeda.

Urutan exit berikut wajib dijalankan pada event socket **dan watchdog 250 ms**:

| Prioritas | Trigger awal | Tindakan |
|---|---|---|
| 1: struktural/darurat | Dev dump ≥$25 sekaligus ≥5% saldo dev terakhir; holder ≥1,5% supply menjual ≥20% saldonya; likuiditas nyata turun ≥20%/3s; token menjadi tidak dapat ditransfer; atau harga socket jatuh ≥8%/1s dengan flow sell ≥70% | Ajukan exit segera lewat rute valid; invalidasi cache yang tidak cocok. Tidak menunggu breakeven, ATH, candle, atau whale-hold 5s. |
| 2: hard risk | `R_net ≤ −6%`, atau socket return dari harga fill ≤−8% meskipun router belum mengejar | Ajukan full exit. −6% adalah ambang keputusan, bukan jaminan batas loss/fill. |
| 3: flow patah | Sell share 5s ≥70%, sell USD ≥$150, ≥3 seller, slope negatif, terjadi pada dua observasi terpisah dalam ≤500 ms | Exit; jika sekaligus kondisi darurat, tidak perlu konfirmasi kedua. |
| 4: profit floor | Peak net ≥+8% | Floor net +1,5%, monoton tidak turun. |
| 5: runner | Peak net ≥+12% | Floor `max(floor_lama, +3%, (100+peak_net)×0,95−100)`. Jual bila R_net menembus floor. |
| 6: target lunak | R_net ≥+20% | Jika buy share 5s <65% atau slope tidak positif, jual. Jika flow kuat dan semua bukti fresh, lanjutkan dengan trailing; ATH lama tidak dipakai sebagai alasan wajib menunggu. |
| 7: tidak berkembang | Hold ≥20s, peak net <+3%, dan flow melemah | Exit. Waktu maksimum hold 90s dari fill, lalu exit lewat rute valid. |

Jika socket terputus atau quote tidak valid >2 detik: blokir entry baru, lakukan upaya memperoleh rute/konfirmasi posisi, dan jalankan prosedur pengurangan risiko dari data valid yang masih ada. **Jangan mengisi harga jual, profit, atau status CLOSED secara fiktif.** Order yang gagal/stuck tetap EXIT_PENDING/UNRESOLVED dan memakai budget modal sampai status/balance terkonfirmasi. Sebelum retry transaksi ambigu, periksa signature dan saldo agar tidak mengirim order duplikat.

Untuk kontrol portofolio awal: maksimal satu posisi, jeda entry 15 menit setelah tiga loss beruntun, dan hentikan entry hari itu jika realised loss + penilaian konservatif posisi unresolved mencapai 2% ekuitas awal hari. Exit posisi lama tetap berjalan. Batas ini juga hipotesis operasional untuk paper, bukan hasil optimasi historis.

## 5. Rencana implementasi

Urutannya penting karena optimasi pada ledger yang salah menghasilkan kesimpulan yang salah.

1. **Benahi kontrak data dan akuntansi.** Pisahkan `socket_return`, `quote_expected_return`, `quote_min_return`, `realized_net_return`; UNKNOWN tetap null. Join hanya `run/position/order/signature`, dedup transaksi riil, hilangkan fallback per mint. Audit perbedaan posisi live dan paper saat risk state direset setelah fill. Prioritas file: `scripts/crypto-db.mjs`, `scripts/serve-aggressive-dashboard-agy.mjs`, `src/research-collector.ts`.
2. **Bangun pengelola quote bersama.** Key mencakup mint, arah, wallet, exact quantity, fee/slippage/MEV dan route context. Gabungkan request hanya jika key benar-benar identik; prioritaskan exit posisi nyata. Simpan slot/TTL/expiry, batalkan cache pada gap harga/pool, ukur freshness serta rate limit. Poll 500 ms hanyalah target jika kuota provider mengizinkan. Public GMGN API mendokumentasikan batas berbeda dari endpoint browser internal.
3. **Implementasikan gate serta mesin status lane.** Tambahkan aturan pure/deterministik di `src/momentum-strategy.ts`, wiring di collector, pemeriksaan `src/prebuy-holder-gate.ts`, dan verifikasi `src/solana.ts`. State: WATCH → ARMED → BUY_PENDING → OPEN → EXIT_PENDING → CLOSED; failure yang ambigu menuju UNRESOLVED. Simpan rules hash pada setiap keputusan.
4. **Pisahkan umur posisi dari umur tab/sesi.** Rotasi worker/sesi tidak boleh menutup posisi secara administrasi pada harga terakhir. Posisi pending wajib tetap dimonitor sampai selesai. Matinya socket tidak boleh mematikan exit timer.
5. **Jalankan replay lalu shadow paper.** Tambahkan hanya satu lane baru ini; V2 dan Wave menjadi pembanding pada waktu/candidate universe yang sama. Dashboard menampilkan coverage quote, biaya, failure, data unknown, dan drawdown, bukan win rate saja. Live default tetap mati.

Tes yang diperlukan saat implementasi: data di masa depan/duplikat/out-of-order tidak memicu buy; dev UNKNOWN tidak lolos; gate holder gagal benar-benar memblokir; quote quantity/fee salah tidak dipakai; quote cache muda tetapi pool berubah dibuang; watchdog tetap bekerja tanpa tick; stop tidak dianggap fill pada harga ambang; partial fill/retry/rotasi/restart menjaga posisi dan kuantitas; reconciliation tidak menghitung fee/posisi dua kali.

## 6. Syarat lane boleh dinilai lebih baik

Data yang sudah dibaca hari ini masuk development/exploration. **Jangan menyebut pembagian waktu historis tersebut sebagai validasi out-of-sample yang belum disentuh.**

- Kumpulkan sinyal yang lolos dan ditolak, event pool/authority, holder snapshot bertimestamp, quote prebuy/periodik, dan konfirmasi saldo. Lanjutkan pengamatan minimal 120 detik setelah keputusan keluar/ditolak untuk mengukur missed runner/crash. Saat tidak ada data lanjutan, tandai censored.
- Bekukan parameter dan rules hash. Uji pada sesi baru minimal 7 hari, minimal 30 slot tiga jam dan 300 trade terukur; ambang waktu/jumlah adalah minimum operasional, bukan jaminan signifikansi.
- Kelompokkan berdasarkan mint dan sesi saat menghitung ketidakpastian. Jangan menghitung re-entry atau banyak lane pada mint sama sebagai sampel independen. Sertakan concurrency, antrean modal, fee gagal, unresolved exposure, dan kesempatan trade yang hilang.
- Replay memakai urutan **waktu penerimaan**, latency empiris, quote yang tersedia saat keputusan, dan fill berikutnya yang mungkin terjadi. Pengamatan yang berhenti ketika strategi lama menjual tidak boleh dipakai untuk mengarang hasil hold lebih lama dari strategi baru.
- Target penerimaan: expectancy all-in >0 dengan batas bawah interval 95% per mint/sesi >0, profit factor ≥1,3, tidak bergantung pada tiga winner terbesar, dan tidak runtuh ketika delay naik ke p95 terukur atau biaya tambahan naik 2 poin. Bandingkan drawdown modal aktual dengan V2/Wave pada periode sama. Kegagalan/missing tidak dihapus dari denominator.
- Coverage bukti eksekusi ≥95% adalah target minimum; nilai sisa unknown/unresolved secara konservatif dalam sensitivity bound. Tidak ada auto-buy baru selama posisi unresolved. Jika kuota/freshness tidak dapat memenuhi desain, lane ini belum layak untuk horizon scalp tersebut.

Hasil yang boleh dinyatakan sekarang: **Guarded Wave v1 adalah kandidat desain yang beralasan untuk diuji; performa gabungan entry, exit, proteksi, dan fee-nya belum terbukti.** Aktivasi live memerlukan tahap implementasi dan hasil validasi baru; tidak dilakukan oleh analisis ini.

## 7. Artefak dan cara melanjutkan tanpa membuka log besar

Baca file ini dan ringkasan JSON terlebih dahulu. Buka records/tick mentah hanya untuk posisi yang sedang diaudit.

- Ringkasan kecil: `reports/lane-audit-summary-2026-10-03.json`.
- Bukti per posisi, quote, statistik lane: `reports/lane-audit-2026-10-03.json`.
- Sensitivitas delay, rebound, filter entry: `reports/lane-dynamics-2026-10-03.json`.
- Reproduksi offline: `node scripts/audit-lane-plan.mjs --cutoff=2026-10-02T23:00:00Z`, lalu `node scripts/audit-lane-dynamics.mjs`.

Script membaca SQLite dengan `readOnly:true` dan menulis hasil hanya ke `reports/`. Folder reports sudah diabaikan Git; script dan plan tersedia di working tree. Nilai finansial di laporan live adalah catatan lokal yang belum direkonsiliasi ulang terhadap seluruh receipt blockchain.

Referensi teknis resmi yang diperiksa: [GMGN routing/quote API](https://docs.gmgn.ai/index/cooperation-api-integrate-gmgn-solana-trading-api) untuk expected output vs minimum output dan batas layanan; [GMGN fee/settings](https://docs.gmgn.ai/index/gmgn-fees-settings) untuk pemisahan fee dan slippage; [Solana transaction fees](https://solana.com/docs/core/fees) untuk biaya transaksi; [freeze authority](https://solana.com/docs/tokens/basics/freeze-account) dan [permanent delegate](https://solana.com/docs/tokens/extensions/permanent-delegate) untuk risiko otoritas token. Penerapan gate di atas adalah keputusan desain proyek, bukan rekomendasi threshold dari dokumentasi tersebut.
