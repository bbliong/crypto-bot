# Protokol dibekukan sebelum replay Adaptive v3

Dibuat 3 Oktober 2026, setelah audit sampai 12:00 WIB, sebelum membaca hasil periode 12:00–19:00 WIB. Target: melampaui AGY secara net-of-cost dan risiko, bukan sekadar menang win rate.

Tidak mengubah `adaptive-wave.ts`, `momentum-strategy.ts`, collector, dashboard, atau konfigurasi live. Implementasi Codex adalah prototipe offline/paper.

## Desain

Regime token: DEFEND/WAIT, IMPULSE, TREND, RECLAIM. Klasifikasi memakai tape 2/5/20 detik yang telah diterima, konsentrasi holder, dev sell, efisiensi arah harga, dan volatilitas. Risiko keras mendahului seluruh pilihan jam. Jam WIB dibagi enam blok empat jam; bukan asumsi sesi wilayah tertentu pasti untung.

IMPULSE: 7s histori, return5 +1..8%, buy5 >=75%, buy2 >=70%, >=5 buyer, buyUSD >=500, top buyer <=35%, efisiensi >=0,45; max hold45s. TREND: histori22s, return5 +0,5..10%, buy20 >=68%, buy5 >=65%, buy2 >=60%, >=4 buyer, buyUSD >=400, efisiensi >=0,55; max hold90s. RECLAIM: histori22s, peak sebelum trough, rebound2..5%, drawdown10<=8%, buy2>=80%, buy5>=65%, buy20>=55%, >=4 buyer, buyUSD>=500, harga di atas weighted price; max hold45s. Semua MC10k–100k, umur>=60s, holder>=100, Top1<=8%, Top5<=25%, dev<=2,5%, tidak ada dump/dev-sell diketahui, data fresh, cost model<=4%. Angka ini hipotesis awal, bukan parameter terbukti optimal.

Exit: net stop tambahan maksimum4 poin di bawah biaya awal dan batas absolut−8%; dev/holder danger atau flash crash segera; trail3..8% mengikuti volatilitas dan kekuatan trend tetapi floor tidak pernah turun; mode kuat harus bertahan1s sebelum promosi exit. Flow lemah mengunci profit lebih cepat; tidak ada averaging down, martingale, atau penambahan stake otomatis.

Lapisan jam belajar hanya dari hasil shadow yang telah selesai sebelum keputusan: statistik regime global, lalu blok-jam yang disusutkan ke global. Sedikit sampel kembali ke statistik global, bukan memilih jam dengan kebetulan satu win. Minimal20 token/3hari dan estimasi konservatif positif; jika tidak, SHADOW/WAIT. Gate ini bukan bukti statistik formal setelah pencarian banyak strategi.

## Pembanding dan keadilan

1. AGY fungsi native yang benar-benar diimpor collector, tidak mengubah implementasi asli.
2. AGY referensi: entry native sama, tetapi peak dilacak dan exit memakai net fee model yang sama. Ini adapter kontrol, bukan klaim AGY telah diperbaiki.
3. Codex event-adaptive tanpa gate jam, untuk melihat apakah rules sendiri memberi edge.
4. Codex event + gate regime/jam, termasuk keputusan tidak entry.

Universe, snapshot as-of, syarat kualitas data bersama, stake$5, toleransi9%/14%, filldelay1s, stress2s, dan additional fee1%/sisi sama. Maksimum satu setup per detail/lane dan satu percobaan per mint/24h untuk seluruh pembanding; bukan replika re-entry5s collector. MC memakai adapter historis bersama. Profit semua pembanding dihitung dengan model biaya sama walaupun keputusan AGY native memakai potongan tetap3%.

Training/deskripsi: semua arsip sebelum 12:00WIB 3Oktober sudah pernah dieksplorasi. Test berikutnya: 12:00–19:00WIB 3Oktober; purge mint yang sudah terlihat sebelumnya, buang setup180s terakhir, tidak memperbaiki parameter berdasarkan hasil test lalu mengulang klaim holdout.

Hasil utama harus positif, lebih baik dari AGY native DAN referensi, sampel minimal30 trade test/100 forward trade pada>=7hari berbeda, drawdown/tail/unknown tidak memburuk, dan tetap layak pada delay/fee stress. Tujuh jam test tidak cukup untuk status menang terverifikasi. Nol entry karena gate menolak bukan kemenangan strategi profit.

Unknown tetap exposure belum selesai; portofolio satu posisi berhenti saat unknown. Tidak mengarang sell saat data berakhir. Replay ini tidak memverifikasi authority/pool/sell simulation atau actual on-chain fills.
