# Momentum v2 — implementasi penelitian

Default `npm run research` memakai `--strategy momentum-v2`. `--strategy legacy` memilih algoritma sebelumnya. V2 hanya untuk paper simulation (`autoBuy: false`), tanpa restart otomatis atau penghapusan history. Konfigurasi stake saat ini tetap dibaca dari YAML. Ambang numerik ada pada `MOMENTUM_RULES` di `src/momentum-strategy.ts`; snapshot lengkap ditulis sebagai `strategy.json` pada setiap run.

## Koreksi terhadap analisa awal

Run 2026-09-22T15-14-05-712Z memiliki 12 posisi dengan P/L -$0.732029. Label `TOP_HOLDER_DUMP` menunjukkan alasan yang dipilih kode, bukan bukti bahwa strategi exit itulah penyebab kerugian. Penjelasan sebelumnya bahwa stop menunggu lima detik menyebabkan semua loss besar belum terbukti: ada trade yang langsung melompat turun dan ada evaluasi yang tertahan persiapan UI. SI tercatat buy dan sell pada timestamp sama meskipun persiapan Buy berakhir 16.345 detik kemudian. SOLANA, LASSE, dan OH menunggu sekitar 18.7–19.7 detik pada persiapan UI.

V2 memasang evaluator sinkron pada penerimaan trade. Evaluator menulis sinyal dan hasil paper segera; request API atau pengisian UI tidak menunda pencatatan exit. Persiapan Buy dilakukan sebelum keputusan entry, tidak diulang sesudah entry. Semua waktu keputusan menggunakan waktu penerimaan aktual.

## Rumus entry

`R5 = 100 × (P(now) / P(now−5 detik) − 1)`.

Harga di sekitar awal jendela harus tersedia dengan toleransi 2 detik, harga terakhir maksimal berumur 2 detik. Minimal empat bucket satu detik harus berisi trade harga. Regresi menggunakan satu harga terakhir per bucket agar seratus transaksi dalam satu detik tidak dihitung sebagai seratus detik tren:

`beta = Σ((t−mean(t)) × (ln(P)−mean(ln(P)))) / Σ((t−mean(t))²)`

`tren5 = 100 × (exp(5 × beta) − 1)`.

Syarat tambahan terhadap screening/candle/distribusi lama:

- R5 minimal +0.25%, maksimal +20%, beta positif, drawdown dari puncak lima detik ≤5%.
- Minimal lima transaksi, tiga wallet pembeli dengan nilai USD valid.
- `buyShare = USD_buy / (USD_buy + USD_sell) ≥60%`.
- Pembeli terbesar maksimal 50% dari total USD buy dalam lima detik.
- Token muda/candle 1–2 wajib memiliki tiga snapshot total holder (dua interval). Masing-masing interval 4–8 detik menunjukkan kenaikan ≥10% dan ≥5 holder; snapshot terakhir berumur ≤6 detik. Satu candle dengan holder >100 tetap bisa lolos melalui pengecualian candle yang ada jika syarat tambahan terpenuhi.
- Data holder API harus sukses dan berumur ≤30 detik, termasuk untuk token matang. Data kurang berarti menunggu, bukan nol otomatis.

## Rumus exit dan prioritas

Semua syarat diperiksa pada setiap trade baru, bukan menunggu polling lima detik. Metrik momentum tetap memakai jendela lima detik.

1. Stop −20% memerlukan dua trade berbeda. Konfirmasi maksimal berupa durasi minimal 1.5 detik; trade kedua di ≤−25% atau bersamaan penjualan besar mempercepat exit. Tidak menunggu candle 1m. Tanpa trade baru, tidak dibuat harga exit fiktif.
2. Penjualan signifikan: dev menjual ≥5% saldo teramati dan ≥$25; top holder ≥1.5% supply menjual ≥20% saldo teramati dan ≥$25; atau whale menjual ≥$150 saat sell share ≥65%. Saldo harus berasal dari snapshot sebelum sell, berumur ≤30 detik. Sell kecil dari holder besar tidak otomatis dump. Akumulasi diperiksa pada lima detik sesudah entry.
3. `sigma = 100 × sqrt(mean(log-return²))`, dihitung dari bucket harga. Jarak trailing `d = clamp(2 × sigma, 4%, 8%)`. Setelah puncak ≥10%, batas profit = `max(+1%, (1+peakReturn)×(1−d)−1)`. Setelah puncak ≥5%, batasnya +1%.
4. Ambil profit +40%, kecuali R5 ≥2%, regresi positif, buy share ≥60%, dan pertumbuhan holder dua interval masih kuat. Batas tertinggi +50%.
5. Profit ≥3% bisa keluar saat regresi dan R5 tidak lagi positif, sell dominan, dan snapshot holder yang masih fresh tidak menunjukkan pertumbuhan signifikan.
6. Cut loss tekanan jual ketika return ≤−8%, sell share ≥70%, minimal 10 trade dari ≥3 penjual, serta tren negatif. Recovery holder boleh menahan syarat ini 10 detik; stop dan penjualan besar tetap berlaku.

Harga exit selalu tick yang benar-benar terlihat. Batas +1% tidak menjamin hasil positif; jika harga melompat dari +6% ke −9%, hasil tetap −9%. Candle market cap tidak diperlakukan sebagai harga token atau quote eksekusi.

## Waktu dan kualitas data

Waktu event GMGN pada run tersebut kadang sekitar dua detik di depan jam penerimaan lokal. V2 memakai arrival time untuk jendela dan batas replay, dengan toleransi jam sumber di depan maksimal tiga detik; ini bukan membaca data masa depan. Trade yang diterima terlambat >2 detik atau mundur terhadap timestamp event sebelumnya tidak menggerakkan sinyal. Timestamp sumber hanya resolusi detik: urutan intradetik tetap mengikuti urutan frame diterima, bukan urutan chain yang terverifikasi. Duplikasi ID tidak boleh memicu exit ganda.

Jumlah token diambil dari `ba`, nilai USD dari `au`; keduanya tidak dipertukarkan untuk menentukan whale. Kepemilikan supply memakai field `amount_percentage` (fraksi ×100), bukan persentase relatif terhadap sampel wallet yang terlihat.

## Replay dan batas kesimpulan

Jalankan:

```
npm run momentum:replay -- research/2026-09-22T15-14-05-712Z research/2026-09-22T14-53-39-656Z
```

Hasil: `/momentum-replay.html`, JSON pada `reports/momentum-replay.json`. Replay mempertahankan entry historis dan menguji exit baru sampai waktu exit historis yang sama. Tanpa sinyal baru diberi `CENSORED`, tidak diasumsikan nol. Perbandingan hanya berlaku pada subset yang memiliki pasangan exit. Pemeriksaan entry baru terpisah; bukan hasil portofolio atau perkiraan profit strategi lengkap. Timestamp API lama masih timestamp request, sehingga replay holder memiliki ketidakpastian timing tersebut; rekaman baru memakai waktu respons.

Ambang ini hipotesis rekayasa yang perlu diuji forward pada data baru. Data dua run dipakai untuk memeriksa implementasi, bukan untuk membuktikan keuntungan. Fee, slippage, dampak harga, dan harga swap yang dapat dieksekusi belum dihitung.
