# Loop G / v9: revalidasi sebelum submit buy

Dibekukan4Oktober2026 sebelum hasil enam kandidat dan outcome06:00–06:30UTC dibaca. Versi AGY tetap unchanged.

Masalah yang diuji: replay native mengirim buy dari sinyal awal tanpa memeriksa ulang perubahan kondisi selama persiapan. Menunggu konfirmasi500ms+pricecapketat pada v5 menghilangkan sebagian besar kesempatan. v9 melakukan satu recheck pada titik waktu tetap, tidak mencari tick terbaik di masa depan.

Enam hipotesis: waktu recheck250/750/1500ms × STRUCTURAL/FULL. Ambil frame pertama pada/selepas waktu recheck, maksimum250ms keterlambatan grid; bila frame/snapshot tidak fresh, SKIP. Waktu order dimulai dari frame recheck tersebut; fill baru terjadi setelah delay1s/2s, sehingga tambahan latency tidak dihapus.

STRUCTURAL: recheck holder/dev/count fresh, priceage≤750ms, MC$10k–$100k, age≥60s, holders≥100, top1≤8%, top5≤25%, dev≤2,5%, distribusi holderallowed. Batalkan devsell≥25/30s, majorholder sell+return2≤0, crash1s≥8%, return2≤−3% yang terukur, atau referenceprice melebihi budget originalprice/(1−9%). Tidak meminta f.ready tambahan ketika riwayat native belum lima detik.

FULL: semua structural di atas, ditambah fungsi entry AGY asli dievaluasi ulang pada tape prefix saat recheck. Tidak melihat apakah native nantinya win/loss. Jika lulus, gunakan exit native unchanged dan fill/fee model bersama. Harga referensi buy baru pada saat recheck; total maximum buyprice tetap originalsignalprice/(1−9%). Buy gagal menanggung modeled failedfee, tanpa membatalkan biaya secara retrospektif. Gate slippage total dipasang pada delayed buy model setelah submit; keputusan entry tidak memakai harga fill masa depan.

TRAIN54 dan AUDIT29 opportunity sama denganv5b. Ranking hanya TRAIN, ≥10closed/3hari untuk eksplorasi, minimum conservativePnL base/delay/fee. Nol entry tidakdipilih. Promosi≥30closed/3hari dan PnL/risk/stress yang konsisten; forward100trade/7hari masih dibutuhkan. Total family hipotesis43.

Enam pilihan dibekukan sebelum membaca periode06:00–06:30UTC. Periode itu boleh mengevaluasi pilihanv8 danv9 bersama karena keduanya ditentukan tanpa membacaoutcome periode tersebut. Tidak memilih ulang dari hasilfresh. Status training gagal tidak terhapus oleh periode baru.
