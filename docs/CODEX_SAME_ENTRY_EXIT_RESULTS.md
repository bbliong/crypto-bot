# Hasil Codex same-entry exit v4 dan validasi tambahan

Diperbarui 4 Oktober 2026. **Status: NO_VALIDATED_OUTPERFORMANCE; tidak diaktifkan live.** Kandidat hasil ranking training adalah `CODEX_TREND`, tetapi training-nya sendiri gagal. Ranking bukan izin promosi. Implementasi Gemini/AGY, collector, dan konfigurasi live tidak diubah oleh pekerjaan ini.

## 1. Apa yang diuji

Enam exit menerima entry AGY yang sama, dengan waktu, harga, kuantitas, dan biaya buy yang identik pada setiap skenario. Kandidat Codex: DEFENSIVE, TREND, PULLBACK, dan CONTEXT. Dua kontrol: AGY_NATIVE unchanged serta AGY_REFERENCE dengan peak/valuasi net dalam harness riset. Ini perbandingan aturan dalam adapter as-of bersama, **bukan replika penuh service AGY**, bukan receipt swap nyata, dan bukan semua transaksi yang benar-benar dieksekusi bot.

Stake model $5; biaya model 1%/sisi dan network 0,000205 SOL/leg; toleransi buy 9%/sell 14%; delay 1 detik. Stress memakai delay 2 detik atau fee 2%/sisi. Slippage tolerance bukan potongan harga tetap. Harga stop bukan jaminan harga fill. Posisi tanpa data eksekusi memadai tetap UNKNOWN.

Protokol asli: [CODEX_SAME_ENTRY_EXIT_PROTOCOL.md](CODEX_SAME_ENTRY_EXIT_PROTOCOL.md). Periode tambahan dibekukan terpisah dalam [CODEX_SAME_ENTRY_OVERNIGHT_PROTOCOL.md](CODEX_SAME_ENTRY_OVERNIGHT_PROTOCOL.md), tanpa retuning atau pemilihan ulang kandidat.

## 2. Hasil historis: 111 entry / 111 mint / 9 hari

Agregat hingga 3 Oktober 19:55 WIB. Mayoritas periode ini sudah pernah dianalisis; bukan holdout baru. Lima buy gagal berlaku pada semua exit.

| Exit | Win / loss | Unknown | PnL diketahui | Batas konservatif |
|---|---:|---:|---:|---:|
| AGY_NATIVE | 27 / 72 | 7 | −$16,2205 | −$51,3903 |
| AGY_REFERENCE | 27 / 69 | 10 | −$17,7723 | −$68,0153 |
| CODEX_DEFENSIVE | 30 / 69 | 7 | −$19,2717 | −$54,4414 |
| CODEX_TREND | 29 / 69 | 8 | −$15,9436 | −$56,1375 |
| CODEX_PULLBACK | 29 / 69 | 8 | −$15,9436 | −$56,1375 |
| CODEX_CONTEXT | 30 / 69 | 7 | −$18,9598 | −$54,1295 |

PnL diketahui mencakup biaya buy gagal tetapi tidak menganggap unknown sebagai nol kerugian. Batas konservatif mengasumsikan kehilangan stake dan biaya terkait pada unknown; **bukan loss terealisasi**. Selisih dua batas konservatif bukan batas matematis keunggulan paired yang belum diketahui.

Kenaikan known PnL TREND atas native sebesar $0,2769 menyesatkan jika unknown diabaikan. Pada 102 pasangan yang keduanya diketahui, selisih hanya **+$0,0492**; 24 membaik, 29 memburuk, sisanya sama. Unknown bertambah dari 7 menjadi 8. Semua kandidat tetap negatif dan gagal training. Hasil TREND dan PULLBACK identik: tambahan grace satu detik belum memberi manfaat terukur.

Pemeriksaan baru paling awal, 3 Oktober 19:00–19:55 WIB, hanya menghasilkan satu entry SENTI: native +$0,2055 vs TREND +$0,2251. Satu win bukan validasi.

## 3. Data baru: 3 Oktober 19:55 – 4 Oktober 10:00 WIB

- 2.993 kunjungan detail, 2.321 mint; 2.666 sesi mempunyai tick yang diterima adapter.
- Hanya 748 sesi berdurasi tercatat ≥90 detik; durasi tidak membuktikan tape kontinu. Satu akhir sesi diinferensikan, tanpa menciptakan tick atau fill.
- 20 sinyal mentah AGY; menjadi **18 entry unik** setelah dua percobaan ulang mint SWORDWIF dibuang. Identitas token memakai mint, bukan simbol.
- Tidak ada buy gagal pada skenario base. Unknown tidak dimasukkan ke win/loss.

| Exit | Win / loss | Unknown | PnL diketahui | Batas konservatif |
|---|---:|---:|---:|---:|
| AGY_NATIVE | 6 / 10 | 2 | −$4,9706 | −$15,0198 |
| AGY_REFERENCE | 4 / 11 | 3 | −$5,5513 | −$20,6251 |
| CODEX_DEFENSIVE | 4 / 11 | 3 | −$3,0953 | −$18,1690 |
| CODEX_TREND | 4 / 10 | 4 | −$2,1696 | −$22,2679 |
| CODEX_PULLBACK | 4 / 10 | 4 | −$2,1696 | −$22,2679 |
| CODEX_CONTEXT | 4 / 11 | 3 | −$2,3877 | −$17,4613 |

Pada 14 pasangan TREND/native yang keduanya diketahui, total perbedaan +$2,8612; hanya 3 membaik dan 7 memburuk. Sebagian besar keuntungan relatif berasal dari satu kasus SWORDWIF (+$4,1857). Tanpa kasus itu, selisih pada pasangan selesai lainnya sekitar **−$1,3245**. Ini diagnosis konsentrasi hasil, bukan alasan membuang outlier dari laporan utama.

Stress delay 2 detik: native 7 win / 9 loss / 2 unknown, known PnL −$1,8834; TREND 2 win / 13 loss / 3 unknown, −$3,9708. Stress fee 2%: native −$6,4945 dan TREND −$4,0752, masing-masing 2 unknown; tetap negatif. Efek exit tidak stabil terhadap delay/biaya.

Portofolio satu posisi yang mulai flat di awal periode berhenti pada entry kedua, Solanita, karena unresolved. Known PnL native −$0,2875 dan TREND −$0,3907; 16 sinyal berikutnya terblokir. Karena itu penjumlahan 18 event independen **tidak boleh disebut hasil portofolio yang dapat dieksekusi bersamaan**. Portofolio ini juga bukan lanjutan otomatis portofolio historis yang sudah terblokir.

## 4. Berapa detail kemarin?

Untuk **3 Oktober 2026, 00:00–24:00 WIB**, gabungan universe beku dan metadata tersimpan mencatat **4.203 kunjungan detail / 3.286 mint unik**. Kunjungan ulang membuat jumlah detail lebih besar daripada jumlah token. Angka ini adalah rekaman yang tersedia, bukan jaminan semua aktivitas service tertangkap. Berbeda dari laporan 2 Oktober yang mencatat 3.540 kunjungan.

## 5. Pelajaran dari kasus konkret

- **SGI, historis:** penurunan satu detik sudah −76,49% saat exit bahaya muncul. Native dan Codex sama-sama berakhir sekitar −89,86% / −$4,5154. Hard stop −6% tidak membatasi fill ke −6%; bukan bukti rugpull on-chain terkonfirmasi, tetapi jelas contoh crash yang tidak terselamatkan.
- **SWORDWIF, 3 Oktober 23:17 WIB:** TREND keluar lebih awal dengan +$0,0124; native −$4,1733. Ini satu contoh proteksi yang berhasil dalam model, bukan jaminan semua rugpull tertangani. Ada mint lain dengan simbol yang sama; jangan menyatukan keduanya.
- **SAM, WORLDPAD, Quants:** exit DANGER akibat major-holder sell dan harga melemah mendahului rebound. Native menang lebih besar. Major-holder sell adalah tanda risiko, bukan kepastian token akan rugpull.
- **ASYMMETRIC, periode baru:** native +$1,2648, TREND −$0,1146. Pemicu yang terlihat adalah dev sell $93,48/30s, bukan major-holder sell. Bahkan bukti dev menjual tidak membuktikan harga pasti langsung runtuh; exit lebih dini tidak selalu lebih baik.
- **cabypara dan ZERO, historis:** menunggu konfirmasi flow membuat hasil Codex lebih baik, tetapi manfaat tidak merata di seluruh cohort.
- **knightcat dan LAGOSLIFE, periode baru:** native selesai, TREND belum keluar ketika capture berakhir. Kedua kasus ini tidak boleh dinilai menggunakan harga jual buatan. Solanita dan Engram unresolved pada kedua exit base.

Audit kasus memilih beberapa perbedaan terbesar secara post-hoc. Harga setelah exit hanya bahan diagnosis; tidak digunakan oleh strategi dan bukan estimasi frekuensi keberhasilan.

## 6. Formula adaptif: keputusan sekarang dan eksperimen berikutnya

Formula v4 tetap tersimpan sebagai **prototype riset**, bukan formula optimal yang terbukti. Arsitektur CONTEXT sudah membaca flow/distribusi/volatilitas; hasilnya belum membenarkan promosi. Tidak mengganti parameter diam-diam untuk memenangkan data yang baru dilihat.

Rencana lanjutan berurutan:

1. **Ketersediaan eksekusi lebih dahulu.** Runner Codex terpisah perlu mempertahankan observasi sampai posisi terselesaikan, mencatat quote exact quantity/as-of, min-output, slot, status transaksi dan biaya. Unresolved harus memblokir entry baru. Tidak mengubah collector AGY. Tahap collector/forward ini belum diimplementasikan di pekerjaan ini.
2. **Pisahkan bahaya cepat dari tekanan sementara.** Hipotesis berikutnya menguji klasifikasi major-holder sell: intensitas, bagian inventory yang dilepas, persistensi seller, dukungan buyer dan perubahan harga. Jangan menghapus exit holder sell hanya karena SAM rebound: SWORDWIF menunjukkan biaya melewatkan exit dini. Crash/dev dump dan batas risiko tetap prioritas, tanpa memperlonggar hard risk untuk mengejar win rate.
3. **Mode dipilih dari kondisi saat itu.** TREND ketika dukungan buyer/arah bertahan; PULLBACK hanya jika dukungan masih ada dan data fresh; DEFENSIVE ketika dukungan melemah. Perubahan grace/konfirmasi adalah versi baru yang harus dibekukan sebelum pengujian baru, bukan dibenarkan oleh rebound yang sudah diketahui.
4. **Jam sebagai prior kecil, bukan tombol wajib beli.** Minimum bukti 20 mint/3 hari per kelompok jam belum terpenuhi. Sampel periode baru: 00–04 WIB 7 entry, 04–08 sebanyak 4, 08–12 sebanyak 1, 20–24 sebanyak 6; masing-masing hanya satu hari. Tidak ada jadwal jam yang layak diaktifkan. Selector kelak hanya memakai outcome yang sudah selesai saat keputusan, dengan bobot ditarik ke rata-rata global bila sampel tipis.
5. **Uji hipotesis tunggal pada data baru.** Pertahankan semua kontrol dan cohort identik; ukur absolute net PnL, unknown, drawdown, tail loss, delay dan fee stress. Seluruh periode laporan ini kini menjadi development/audit yang sudah dilihat. Tetap perlu ≥100 trade forward pada ≥7 hari serta kelulusan training sebelum klaim unggul/live.

Perubahan utama yang dibutuhkan bukan memperbesar stake, mengecilkan asumsi fee, memilih hanya trade selesai, atau memaksa jam tertentu terlihat menang.

## 7. Artefak dan verifikasi

- `src/codex-same-entry-exits.ts`: empat exit Codex terpisah.
- `scripts/replay-codex-same-entry-overnight.mjs`: validasi tambahan, hash aturan beku, inventory dan parity buy.
- `scripts/audit-codex-same-entry-cases.mjs --overnight`: diagnosis kasus periode baru tanpa menimpa hasil lama.
- `scripts/audit-codex-overnight-repro.mjs`: pemeriksaan ulang sumber aktif pada cutoff yang sama.
- `reports/codex-same-entry-summary.json` dan `reports/codex-same-entry-overnight-summary.json`: agregat kecil.
- Ledger terperinci, audit kasus, serta inventory/hashes tersimpan pada `reports/codex-same-entry-*`; tidak dimuat seluruhnya ke konteks percakapan.

Historis: 672 pemeriksaan parity terhadap hasil AGY sebelumnya dan 8.136 pemeriksaan kesamaan field buy. Tambahan: 1.440 pemeriksaan field buy. **168/168 tes lulus**, typecheck lulus. Source AGY, momentum strategy, collector, dan konfigurasi live memiliki hash yang sama sebelum/sesudah pekerjaan lanjutan ini.

Catatan reproduksi: arsip raw 24 September sudah tidak tersedia akibat perubahan workspace di luar pekerjaan ini; laporan beku tetap dipertahankan, tetapi replay raw historis penuh membutuhkan arsip itu. Jangan menganggap sumber hilang berarti tidak ada trade. Lima sumber lama memunculkan WAL SQLite kosong saat dibaca read-only; itu bukan perubahan observasi. Sumber aktif bertambah saat analisis; replay ulang pada cutoff tetap menghasilkan 243 sesi, 1 sinyal dan 18 outcome yang identik dalam representasi JSON. Ini bukan klaim snapshot byte-exact seluruh raw capture.

Jalankan validasi tambahan dari root proyek (keluaran tambahan ditimpa jika sengaja menjalankan ulang; laporan historis tidak disentuh):

```sh
node --import tsx scripts/replay-codex-same-entry-overnight.mjs
node --import tsx scripts/audit-codex-overnight-repro.mjs
node --import tsx scripts/audit-codex-same-entry-cases.mjs --overnight
npm test
npm run typecheck
```
