# Codex Guarded Wave — versi terpisah dari Gemini/AGY

Tanggal analisis: 3 Oktober 2026. ID: `codex-guarded-wave-v1`.

**Status: implementasi penelitian offline/paper, belum terhubung ke collector atau AutoBuy. Belum ada formula yang lolos validasi.** Versi Gemini/AGY, `adaptive-wave.ts`, lane Wave yang sudah ada, konfigurasi live, dan dashboard tidak diedit oleh pekerjaan ini.

## 1. Jawaban hasil satu hari

Periode: **2 Oktober 2026, 00:00–24:00 WIB**, setara 1 Oktober 17:00 sampai 2 Oktober 17:00 UTC. Universe berasal dari seluruh `DETAIL_STARTED` pada waktu tersebut, bukan hanya token yang pernah dibeli lane lama.

| Bukti pada arsip | Jumlah |
|---|---:|
| Kunjungan detail | 3.540 |
| Mint/token berbeda | 3.416 |
| Kunjungan dengan tick harga socket | 3.226 |
| Kunjungan dengan quote buy | 556 |
| Kunjungan dengan quote buy dan sell | 555 |
| Durasi detail tercatat minimal 90 detik | 1.062 |
| Ditutup awal karena `OBSERVATION_ABORTED_DUMP` | 2.436 |
| Waktu akhir detail tidak tersedia | 39 |

Median durasi detail 34,612 detik. Sebanyak 1.065 kunjungan berakhir dengan alasan `OBSERVATION_WINDOW`; angka itu berbeda dari durasi ≥90 detik. Pada 39 kunjungan tanpa akhir eksplisit, batas maksimum 90 detik hanya dipakai sebagai batas pencarian, **bukan untuk menciptakan tick atau fill**.

Ada 12 quote berlabel post-exit pada input hari tersebut. Keberadaannya tidak berarti seluruh 3.540 detail memiliki rangkaian quote selama 90 detik. Pemantauan quote dimulai dari entry paper lama; quote untuk kuantitas/entry lain tidak dapat langsung dianggap fill lane baru. Pada 10 sinyal baseline Codex, **tidak ada quote buy atau round-trip yang sudah diterima dan berumur ≤750 ms**.

### Hasil portofolio model, bukan hasil swap nyata

Formula baseline `frozen/balanced`: 9 detail pernah memenuhi seluruh filter terukur pada satu tick; setelah konfirmasi dua tick berbeda, tersisa 10 sinyal pada **4 token**. Satu posisi/pending order aktif, satu entry sukses per mint per hari; buy gagal boleh dicoba lagi setelah hasil gagalnya diketahui.

| Skenario | Posisi selesai | Win | Loss | Buy gagal | PnL model termasuk fee gagal |
|---|---:|---:|---:|---:|---:|
| Stake konfigurasi $0,50, cost gate dipatuhi | 0 | 0 | 0 | 0 | $0; 10 sinyal ditolak biaya |
| $0,50, cost gate sengaja dilewati untuk diagnosis | 3 | 0 | 3 | 2 | −$0,1954 |
| $10, sensitivitas ukuran saja, delay 1 detik | 3 | 1 | 2 | 2 | −$0,6324 |
| $10, sensitivitas ukuran saja, delay 2 detik | 2 | 0 | 2 | 3 | −$1,4603 |
| $10 + biaya tambahan 1% per sisi, cost gate dipatuhi | 0 | 0 | 0 | 0 | $0; semua sinyal ditolak biaya |

**$10 tidak diterapkan ke konfigurasi dan bukan anjuran menaikkan stake.** Ini eksperimen untuk memisahkan efek fixed fee dari mutu sinyal. Skenario tanpa cost gate bukan implementasi patuh Guarded Wave. Semua eksperimen harga mengasumsikan bukti struktural/eksekusi yang tidak ada; gate eksekusi ketat tidak akan mengizinkannya.

Per token, skenario diagnostik $10/delay 1 detik:

| Token | Buy WIB | Sell WIB | Alasan meminta sell | Return net model |
|---|---|---|---|---:|
| SexAI | 11:15:18.701 | 11:15:25.449 | Penjualan besar holder/dev yang diketahui | +0,9220% |
| home | 14:14:40.888 | 14:14:45.601 | Socket tidak fresh >2 detik | −0,1767% |
| Lucy | 16:53:50.246 | 16:53:51.489 | Hard risk | −6,7975% |

Lucy sebelumnya mengalami satu buy gagal; LONG juga gagal buy. Keduanya tetap masuk ledger biaya. Angka return adalah rasio SOL expected setelah biaya model, bukan perubahan harga USD mentah.

## 2. Apakah melindungi dari rugpull?

Pada **484 kunjungan / 483 mint**, harga socket fresh jatuh minimal 30% dari puncak 10 detik sebelumnya, dalam 90 detik pertama detail. Baseline tidak mengeluarkan sinyal sebelum crash pada kunjungan tersebut.

Ini bukti penyaringan terhadap **fast crash teramati**, bukan akurasi deteksi rugpull. Tidak ada label on-chain lengkap untuk mengonfirmasi pencabutan likuiditas, cluster pengendali, atau sell yang mustahil. Sebagian besar token memang tidak pernah boleh dibeli karena data/flow tidak lengkap. Tidak masuk posisi bukan bukti bahwa exit bisa menyelamatkan posisi saat likuiditas hilang.

Loss Lucy menunjukkan bahwa stop −6% adalah pemicu keputusan, bukan jaminan fill −6%. Pada delay 2 detik, loss Lucy menjadi sekitar −11,11%. Model tidak menjual fiktif tepat pada ambang stop.

## 3. Pencarian formula Codex

Keluarga pengujian dibatasi **6 entry × 3 exit = 18 formula**. Tidak mencari ribuan kombinasi sampai kebetulan menemukan grafik hijau.

| Profil entry | Perubahan dari baseline | Sinyal / mint, seluruh hari |
|---|---|---:|
| frozen | Holder/dev/count fresh ≤10s; flow5 ≥60%, flow20 ≥65%; return5 +0,25..20% | 10 / 4 |
| cadence | Holder/count ≤15s, dev ≤35s untuk menilai efek cadence API | 32 / 13 |
| snapshot30 | Holder/count ≤30s, dev ≤35s | 62 / 19 |
| quality | Cadence; buyer ≥5, flow5 ≥65%, flow20 ≥70%, return5 +0,5..12% | 17 / 6 |
| recovery | Cadence; flow5 ≥65%, return5 +0,5..10%, drawdown5 ≤1,5% | 15 / 6 |
| continuation | Cadence; flow5/20 ≥70%, return5 +2..15% | 12 / 5 |

Exit dibandingkan: balanced (net stop −6%, trail 5%), defensive (net stop −4%, floor lebih awal, trail 4%, maksimum 45s), runner (net stop −6%, trail 7%). Semua tetap memiliki darurat holder/dev, stale-data exit, dan fee-aware valuation.

Pemilihan hanya memakai WIB 00:00–12:00. Pemeriksaan berikutnya 12:00–18:00 dan 18:00–24:00. Mint yang sudah terlihat di bagian sebelumnya dikeluarkan dari bagian berikutnya; sinyal pada 90 detik terakhir tiap bagian tidak dipakai. Eksekusi tidak boleh mengambil tick melewati batas bagian.

Syarat awal kandidat: minimal 20 posisi selesai pada bagian pemilihan, tidak unresolved, PnL konservatif positif, dan batas bawah PnL resampling blok tiga jam positif. **Tidak satu pun lolos.** Empat blok training terlalu sedikit untuk keyakinan statistik kuat. Hari ini juga sudah diperiksa sebelumnya: pembagian ini merupakan pemeriksaan kronologis retrospektif, **bukan holdout baru yang belum disentuh**.

Temuan penting:

- Baseline hanya punya 1 posisi training, +$0,0924; tidak cukup dijadikan bukti. Pemeriksaan jam 12–18 menghasilkan 0 win/2 loss dan −$0,7120 termasuk buy gagal.
- `cadence/defensive`: training 2 win/1 loss tetapi PnL −$0,8878. Win rate lebih tinggi tidak berarti lebih baik.
- `snapshot30/defensive`: training 2 win/2 loss, PnL −$2,4006 termasuk fee gagal. Snapshot lebih longgar menambah transaksi, bukan profit.
- `cadence/balanced` dan beberapa varian lain mengalami posisi **UNRESOLVED**; portofolio kemudian diblokir. Posisi tersebut tidak dihapus supaya statistik tampak baik.
- Pada GOAT, retry sell setelah slippage gagal tetap menghasilkan kerugian. Memperlebar toleransi tanpa memperhitungkan gap bukan solusi yang terbukti.

Nama `researchLeader: frozen/balanced` di JSON hanya berarti peringkat training tertinggi dalam keluarga ini, dengan beberapa hasil seri. **Bukan formula pemenang yang tervalidasi.** `selectedTrainingCandidate` tetap `null` dan `liveAllowed` tetap `false`.

## 4. Formula yang diimplementasikan

Baseline konservatif tetap menjadi kontrol paper. Entry membutuhkan semuanya sekaligus:

1. Minimal 20s observasi, umur token ≥60s, harga diterima ≤750ms dan event tidak terlambat/out-of-order.
2. MC $10k–$100k; holder ≥100; Top1 ≤8%, Top5 ≤25%, total dev ≤2,5%; data holder/dev/count valid dan fresh.
3. Return5s +0,25..20%, slope positif, drawdown5s ≤2,5%; ≥5 trade, ≥4 buyer, buy USD ≥$300, buyer terbesar ≤50% volume buy.
4. Buy share5s ≥60% dan share20s ≥65%; tidak ada dev sell ≥$25/30s atau dump holder besar yang diketahui; candle berjalan tidak merah.
5. Dua tick berbeda berjarak 150–500ms; pergerakan >2% atau gagalnya gate mereset setup.
6. Gate eksekusi **terpisah**: mint/pool/sell simulation terverifikasi, quote exact quantity, slot/min-output valid, umur quote ≤750ms, RTT ≤1s, impact ≤1%, deviasi terhadap socket ≤2%.
7. `expectedNet = 100 × (sellNetSOL / buyAllInSOL − 1)` harus ≥−3%; minimum-output net ≥−6%; stake ≤1% ekuitas; tidak ada posisi/pending yang unresolved.

Mengubah hasil setup menjadi izin transaksi tanpa gate nomor 6–7 adalah salah penggunaan modul. Replay diagnostik diberi label khusus karena arsip tidak dapat memenuhi gate tersebut.

Exit baseline: darurat struktural/holder dahulu; stale >2s; flash crash ≥8%/1s dengan dominasi sell; hard net ≤−6% atau socket ≤−8%; flow patah dikonfirmasi dua tick; peak net +8% mengunci floor +1,5%; peak net +12% memakai `max(floorLama, 3, (100+peakNet)×0,95−100)`; target +20% hanya dijual jika flow melemah; stagnasi 20s dan batas hold 90s. Floor monoton, tidak boleh turun saat berpindah fase.

Watchdog 250ms tetap mengevaluasi exit tanpa tick baru. Keluaran fungsi exit hanyalah **permintaan keluar**, bukan status CLOSED. Pending/gagal/akhir capture tetap memiliki risiko modal sampai terkonfirmasi.

## 5. Model biaya dan batas keaslian replay

Eksperimen memakai 1% per sisi sebagai fee GMGN, serta 0,000205 SOL per leg sebagai asumsi priority + tip konfigurasi + base satu signature. Fee model percobaan gagal 0,000105 SOL. Ini bukan rekonsiliasi receipt pengguna. Fee DEX/creator, ATA rent, MEV, dan market impact belum diketahui; skenario utama bersifat optimistis. Dokumentasi [GMGN fee](https://docs.gmgn.ai/index/gmgn-fees-settings) memisahkan fee platform, biaya jaringan, dan slippage; [Solana fee structure](https://solana.com/docs/core/fees/fee-structure) menjelaskan base/priority fee termasuk transaksi gagal.

Pada empat token baseline, immediate round-trip model stake $0,50 sekitar **−11,32% sampai −11,44%**. Jadi posisi bisa melanggar net stop sebelum harga bergerak. Memaksa entry lalu hard stop hanya membakar biaya. Slippage 2%/5% adalah batas toleransi model, bukan fee yang otomatis dipotong.

Fill model menggunakan tick fresh pertama sesudah delay 1s/2s, maksimal menunggu tambahan 2s. Harga gap tidak dijepit ke harga stop. Jika melewati slippage cap, order model gagal dan dikenai fee; sell retry maksimal tiga kali. Hilangnya data menghasilkan UNKNOWN/UNRESOLVED. Dalam live, kegagalan/timed-out ambigu wajib direkonsiliasi dengan signature/balance sebelum retry; [GMGN failure guidance](https://docs.gmgn.ai/index/transaction-limit-order-failure) juga memperingatkan ketidakpastian status transaksi.

MC replay diperkirakan dari harga × supply inferensi snapshot holder; bukan supply on-chain terverifikasi. Identitas LP berdasarkan tag arsip juga belum merupakan verifikasi protokol. Gate struktural ini tetap tidak tersedia untuk klaim hasil live.

## 6. Perubahan file dan reproduksi

File Codex sendiri:

- `src/codex-guarded-wave.ts`: setup, konfirmasi, gate ekonomi/eksekusi dan exit pure/deterministik.
- `scripts/codex-guarded-wave-engine.mjs`: adapter as-of dan ledger fill/failure/unknown offline.
- `scripts/research-codex-guarded-wave.mjs`: 18 kandidat, pemisahan waktu, sensitivity dan laporan.
- `tests/codex-guarded-wave.test.ts` serta `tests/codex-guarded-wave-engine.test.mjs`.

Tidak menambahkan ID Codex ke lane Gemini maupun enum/wiring collector. Menjalankan script di bawah **tidak memulai browser, tidak memanggil API trading, dan tidak mengirim transaksi**:

```sh
# Sekali untuk mengekstrak input hari yang dipilih (membaca SQLite read-only):
node scripts/load-guarded-wave-day.mjs

# Replay baseline audit terdahulu:
node --import tsx scripts/replay-guarded-wave-day.mjs

# Pengujian versi Codex terpisah:
node --import tsx scripts/research-codex-guarded-wave.mjs
node --import tsx --test tests/codex-guarded-wave.test.ts tests/codex-guarded-wave-engine.test.mjs tests/guarded-wave-replay.test.mjs
```

Baca ringkasan kecil lebih dahulu: `reports/codex-guarded-wave-summary-2026-10-02.json`. Detail ledger ada di `reports/codex-guarded-wave-research-2026-10-02.json`; audit coverage dan crash ada di `reports/guarded-wave-replay-summary-2026-10-02.json`. Input besar disimpan di disk; tidak perlu dimasukkan seluruhnya ke konteks percakapan. Hash input dan keluarga aturan disimpan pada laporan untuk reproduksi.

Verifikasi: `npm run typecheck` lulus; `npm test` **122/122 lulus**, termasuk 25 tes audit/replay Codex. Hasil baseline dan engine Codex dicocokkan untuk jumlah win/loss/PnL; urutan timestamp buy/sell juga diperiksa. Source hash disimpan karena perubahan fungsi metrik bersama pada masa depan dapat mengubah reproduksi.

## 7. Keputusan dan langkah pengembangan berikutnya

**Keputusan pada data ini: jangan trading live dengan formula Codex yang belum tervalidasi.** Ini hasil seleksi yang sah, bukan target win rate yang sengaja diturunkan. Tidak ada jaminan formula optimal global dari satu hari dan empat token baseline.

Hambatan yang perlu dibereskan sebelum eksperimen berikutnya adalah bukti prebuy, bukan menambah filter tanpa batas: refresh holder/dev ketika setup mendekati valid; rekam quote buy dan round-trip sebelum order, termasuk slot/min-output/exact quantity; verifikasi supply/authority/reserve; pertahankan capture posisi setelah tab berganti; rekonsiliasi actual fee dan fill. Freshness snapshot perlu dipenuhi dengan pengambilan data, bukan diasumsikan aman karena interval API panjang.

Perubahan collector untuk kebutuhan tersebut **belum dilakukan**, agar implementasi Gemini/AGY tidak tersentuh. Integrasi berikutnya harus melalui collector/runner Codex yang terpisah dan forward-paper pada hari baru, dengan stake pilihan pengguna tetap dipertahankan. Hanya setelah coverage eksekusi dan hasil bersih terukur membaik, formula entry/exit dapat dinilai ulang.
