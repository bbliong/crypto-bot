# Analisis tick token loss + rekomendasi engineering/strategi paper

Dibuat: 2026-11-12 16:28:39 WIB.
Periode FIXED: 12 November 2026 13:25:41–15:25:41 WIB, sama dengan laporan sebelumnya.
Scope: AP1/AP2/AP3, lima CA berbeda, sepuluh posisi loss tercatat. Tidak mengambil rolling dua jam baru.
Mode: PAPER/DRY_RUN; status kualitas bukti PARTIAL. Tidak ada backtest kuotasi baru, konfigurasi live, signing, transaksi, restart, atau implementasi rekomendasi.

## Ringkasan bukti
- 129 transaksi whale terdeduplikasi: Ed9Y 47, EGxf 35, 2yY3 17, EVGn 23, 27QCs 7. Ini bukan seluruh tick pasar.
- 10 loss instances: 3 exit dengan quote BUY/SELL tersedia, 1 attempted exit no-route, 6 timeout administratif yang langsung ditulis nol.
- 3 exit ber-quote berasal dari SATU mint Ed9Y di tiga AP, bukan tiga eksperimen independen. Enam timeout juga hanya berasal dari tiga CA.
- Control winner pada periode yang sama: F66H, dua posisi menang AP1/AP2 pada CA yang sama. Optimasi hanya pada loser menimbulkan selection bias.
- Tick harga whale/spot tidak setara quote liquidation seluruh posisi. Jangan menghasilkan PnL hipotetis dengan peak, interpolasi tick kosong, atau harga whale genesis.
- Jam transaksi, waktu terima journal, waktu entry state dan waktu quote selesai disimpan terpisah; timestamp transaksi yang sudah lebih awal belum tentu tersedia saat bot memutuskan.

## 1. RICO Ed9Y — giant sell mengalahkan exit reaktif
CA: `Ed9YTiUiA232PjL1eDgwfZFZMRxMxhmshKGvhXnBDKft`.
- 13:57:01 whale BUY 30 SOL.
- 13:58:06 AP masuk; entry AMM kedua AP2/AP3 sekitar $0.00007037.
- 13:58:15 harga whale $0.0000732852; 13:58:33 $0.0000781219; 13:58:43 $0.0000813704 (+15.6% terhadap entry AP2).
- 13:58:45 whale SELL 23.76891916 SOL, holding 70.535 juta → 39.248 juta. Di detik yang sama ada buyback dengan harga $0.0000493285; urutan transaksi mengikuti si.
- Request SELL baru masuk journal sekitar 13:58:46; quote sukses net $3.49 AP1 dan $3.47 AP2/AP3, PnL buku -$1.51/-$1.53/-$1.53.
Diagnosis: guard giant sell aktif, tetapi setelah whale mengubah harga. Tidak ada TP1 pada state; observed whale rise belum +50%. SL bukan batas loss eksekusi yang pasti.
Saran spesifik: uji profit-taking lebih awal sebagai paper variant, serta per-position executable quote/latency trace. Menurunkan giant threshold saja belum terbukti memperbaiki expected return.

## 2. RICO EGxf — distribusi kecil berkala + posisi tak pernah di-quote SELL
CA: `EGxfKsaAg2yxUDyYAa5cWDfgLrFjsEqPJqZcVDNehrtA`.
- 14:05:02 whale BUY 30 SOL.
- 14:06:03 AP2/AP3 entry; AMM kedua sekitar $0.00006661.
- 14:06:29 whale SELL 1.94224709 SOL; order kecil berikutnya tetap diselingi buyback.
- 14:07:11 harga whale $0.0000806082, +21.0% terhadap entry AP2; masih belum TP1 +50%.
- 14:07:13 aktivitas whale terakhir teramati, holding 53.383 juta. 14:07:14/15 muncul generic watcher hint Withdraw/RemoveLiquidity, belum mint-linked proof.
- 14:31:13 ketiga AP ditutup administratif return nol: masing-masing -$5. Tidak ada SELL quote ketiga AP pada posisi ini.
Diagnosis: sell di bawah threshold signifikan/giant dan diselingi buyback dapat lolos; tidak ada bukti likuidasi -100%.
Saran spesifik: ukur net perubahan holding/flow rolling, bukan streak sell saja; jangan menghapus exposure dan memalsukan exit nol saat timeout.

## 3. DogShit 2yY3 — kenaikan pendek, lalu stale/write-off
CA: `2yY3Dv3hRrw3uJikQbuvBJrYhrP4Qe3xEKSdxdKbFkC4`.
- 14:34:54 whale BUY 30 SOL.
- AP1 masuk 14:35:25; AP2 masuk 14:35:55 pada entry AMM kedua sekitar $0.00006698. AP3 tidak masuk karena kas habis.
- 14:35:58 whale BUY 1.1156 SOL; 14:36:05 SELL 0.9162; 14:36:06 BUY 0.2; 14:36:15 SELL 0.7097.
- 14:36:21 SELL 0.5714 SOL pada harga $0.0000793157 (+18.4% terhadap entry AP2). Holding masih 67.426 juta.
- 14:36:26/27 generic watcher hints; tanpa bukti drain mint-linked.
- AP1 15:00:41 dan AP2 15:01:12 ditutup administratif -$5 masing-masing tanpa quote SELL.
Diagnosis: data tidak membuktikan seluruh loss akibat whale giant dump. Masalah stale valuation/timeout lebih nyata daripada klaim rugpull.
Saran spesifik: watchdog price/quote freshness dan pool reserve khusus posisi terbuka, bukan mengandalkan pesan whale aktif.

## 4. DogShit 27QCs — tidak ada tick whale sesudah entry
CA: `27QCsZktrKt3jUSQ2GurTRxsuKA7APt3oqjQ7yD4HAcU`.
- 14:37:12 whale BUY 30 SOL.
- 14:37:25 SELL 0.6417; 14:37:31 SELL 0.9090; 14:37:36 SELL 0.9741; 14:37:44 BUY 0.2 SOL.
- 14:37:49 whale BUY 0.5217 dan SELL 0.5817 SOL. AP1 baru membuat entry state 14:37:49.694.
- 14:37:50.492 quote AMM kedua berhasil, entry sekitar $0.00006926.
- 14:37:52.406/53.372 generic watcher hints, bukan bukti drain mint/pool tertentu.
- Tidak ada raw whale event dengan transaction timestamp sesudah entry state AP1 di snapshot 2 jam. Harga naik setelah entry atau kesempatan TP10: UNKNOWN.
- 15:03:14 AP1 ditutup administratif -$5 tanpa SELL quote. AP2 sempat membuat BUY provisional, tetapi tidak ada posisi finalnya dalam snapshot; jangan dihitung sebagai loss AP2.
Diagnosis: ini counterexample terhadap saran menyamaratakan semua loser sebagai sempat +15–21%. Tidak ada dasar untuk mengklaim TP10 akan menyelamatkan CA ini.
Saran spesifik: verifikasi sellability dan risk/freshness sebelum entry, lalu monitor reserve/quote per posisi. Grace lebih lama belum terbukti solusi universal.

## 5. 十七 EVGn — warning sebelum entry; stop loss saat route sudah bermasalah
CA: `EVGnk8g8XppG7UAkA14CSMN4h9ViWyfqZBU68F8a5WMe`.
- 14:43:03 whale BUY 30 SOL.
- 14:43:55 whale SELL 8.399177242 SOL, lalu sell kecil; ini sebelum AP2 entry.
- 14:44:04 AP2 tetap masuk setelah grace 61 detik; AMM kedua sekitar $0.00006511.
- 14:44:21 harga whale $0.0000704488; 14:44:42 $0.0000753827; 14:45:03 $0.0000768713 (+18.1% terhadap entry AP2).
- 14:45:06/07 generic watcher hints.
- 14:45:56 stoploss memakai harga $0.00000005074; 14:45:58.787 probe SELL little pool hit. Buku dikoreksi -$5/-100%, bukan SELL berhasil.
Diagnosis: grace+bundler+holding ratio tidak menolak warning distribusi sebelumnya. Belum diketahui waktu pertama harga/quote melewati -20%; tidak ada tape lengkap.
Saran spesifik: tambahkan warning recent heavy distribution yang ternormalisasi bag/reserve dan minta revalidasi; bukan unconditional block setiap order 8 SOL berdasarkan satu contoh.

## Rekomendasi saya, urutan prioritas
### P0 — Perbaiki alat ukurnya sebelum menilai strategi
1. Samakan actual affordable stake, quote request, posisi dan cash debit. Contoh RICO F66H: AP2 stake event $0.655 tapi quote nominal $5; RICO EGxf AP3 stake $3.445 tapi quote $5. Token quantity dan fee harus berasal dari kuotasi terpilih yang sama.
2. Timeout tidak boleh mengarang successful SELL nol. Gunakan OPEN_UNPRICED/EXIT_UNAVAILABLE; tampilkan exposure tetap terkunci dan UNKNOWN liquidation value. Conservative reserve/write-down boleh terpisah, bukan realized trading result.
3. Simpan raw token_stat/token_activity, kedua probe BUY, seluruh SELL quote, full signature, mint/pool, context slot/commitment, source time dan receipt time.
4. Riwayat BUY per mint harus durable per lane di luar recentEvents/closedTrades yang bisa reset/truncate; guard persisten+inflight tidak boleh hilang saat histori dipangkas.

### P1 — Tutup blind spot posisi terbuka
5. Source saat audit sudah punya subscribe open mint dan fallback DexScreener 30 detik; jangan mengklaim pasti unsubscribe. Tetapi fallback AMM unindexed di runner hanya mengiterasi smartOpen, bukan seluruh posisi AP. Saya sarankan freshness/SLA dan bounded direct-AMM liquidation quote untuk posisi AP juga, sesuai kuota/latensi yang diukur.
6. Gunakan pool/vault account watcher yang memetakan mint+pool+reserve. Generic Withdraw/ClosePosition/ClaimPositionFee tidak boleh dijadikan emergency sell tanpa decoder dan evidence reserve terkait.
7. Saat quote/price stale, larang entry tambahan; jalankan revalidasi bounded. Tidak adanya tick whale bukan otomatis token mati; kesehatan socket global juga bukan freshness per mint.
8. Untuk entry, review recent net holding/flow dan ukuran sell relatif bag/pool. Buyback kecil jangan otomatis menghapus seluruh warning distribusi. Freeze/reverify adalah ide uji, bukan filter yang sudah terbukti menang.

### Eksperimen strategi — SATU perubahan dulu, PAPER ONLY
9. Tetap simpan AP2 lama sebagai control. Kandidat pertama yang saya pilih untuk diuji: entry sama, tetapi FULL EXIT saat quote liquidation SELURUH posisi menunjukkan net PnL >=+10%, bukan menunggu TP1 spot +50%. Angka +10% adalah HIPOTESIS, bukan parameter optimum hasil backtest.
10. Pakai initialCashOutlay = actualStake + buyFee. Untuk full-exit variant: netLiquidation = quoteGrossUsd - expectedSellFee; netPnlPct = (netLiquidation - initialCashOutlay) / initialCashOutlay * 100. Biaya DEX yang sudah tercakup quote jangan dikurangi dua kali; fee paper tetap dilabeli model, bukan biaya on-chain aktual.
11. Jangan ubah entry, TP, SL, trailing, dan threshold whale sekaligus. Setelah kandidat pertama terukur baru uji partial/trailing terpisah jika perlu.
12. Tidak menghitung profit alternatif memakai tick whale/peak. Jika tidak ada historical quote pada trigger hipotetis, hasil replay harus UNKNOWN, bukan simulasi return buatan.

## Validasi agar saran tidak overfit
- Sampel ini hanya lima mint loser dan satu mint winner control; posisi lintas AP pada mint sama saling berkorelasi.
- Bekukan aturan sebelum mengambil holdout sesi berikutnya; nilai semua kandidat, termasuk winner F66H dan token yang diblok. Jangan memilih hanya token yang gagal.
- Gunakan urutan RECEIPT time dan data yang sudah tersedia saat keputusan; jangan memakai future tick, future reserve, atau label pool mati yang baru diketahui belakangan.
- Group hasil menurut mint/dev/day jika identitas terverifikasi. Compare coverage/trade frequency, net quote return, biaya, latency, no-route, time-to-exit dan exposure UNKNOWN; jangan hanya win rate.
- Catat real quote failures apa adanya, batasi retry/network, jangan mengganti kegagalan dengan harga chart.
- Saya belum menjalankan replay PnL alternatif karena historical quote lengkap pada waktu trigger alternatif tidak tersedia.

## Rujukan teknis resmi (bukan bukti rugpull lima token ini)
- Solana accountSubscribe menyediakan notifikasi saat account data/lamports berubah dan menyertakan context.slot. Ini fondasi watcher, bukan jaminan bisa keluar sebelum dump. Dokumentasi: `https://solana.com/docs/rpc/websocket/accountsubscribe`.
- getTransaction mengambil transaksi berdasarkan signature beserta meta/slot/blockTime jika tersedia; ini untuk verifikasi instruksi/mint/reserve, bukan menebak dari prefix signature. Dokumentasi: `https://solana.com/docs/rpc/http/gettransaction`.

## Deliverable dan scope perubahan
- Raw/summary dan CSV semua 129 tick: `/home/bbliong/project/crypto-bot/data/reports/loss-ticks-suggestions-20261112-162839`.
- Raw: `raw-evidence.json`; rekomendasi machine-readable: `suggestions.json`; tick: `whale-ticks.csv`.
- Source utama adalah snapshot sebelumnya dan journal bound periode yang sama; laporan AP2/AP3 sebelumnya menjadi cross-check.
- Seluruh rekomendasi berstatus PROPOSED_NOT_IMPLEMENTED atau HYPOTHESIS_NOT_BACKTESTED. Tidak ada perubahan source/config/service/trading.
