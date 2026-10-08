# Loop C: koreksi batas harga konfirmasi

Dibekukan setelah diagnosis TRAIN v5b, sebelum hasil kandidat C. Tetap research-only, tidak mengubah AGY atau versi v5/v5b.

Bukti TRAIN: dari54 opportunity, CONFIRM_1S hanya masuk3 dan CONFIRM_3S nol. Ada43 opportunity dengan frame kualitas valid setelah1s, tetapi23 di antaranya selalu di atas price cap +1%. Banyak setup juga dibatalkan karena danger. Ini alasan menguji cap volatilitas; bukan alasan menghilangkan safety gate atau memakai harga sebelum keputusan.

Tepat8 kandidat: CONFIRM_1S/CONFIRM_3S × exit NATIVE/HARVEST × gate ALL/AGE300. Semua recheck, pembatalan danger, konfirmasi dua tick≥500ms, jendela12s dan biaya sama dengan v5. Satu perubahan: capPct=clamp(0,75×sigma1 pada saat opportunity,1%,5%). Sigma yang tidak diketahui berarti SKIP; cap dibekukan saat opportunity, tidak diperbesar setelah harga bergerak.

TRAIN sebelum3Oktober12WIB; AUDIT3Oktober12WIB–4Oktober10WIB, dengan first-seen purge dan embargo180s seperti v5b. AUDIT sudah terpakai: hanya diagnostik, bukan holdout. Ranking memakai minimum conservative PnL di tiga skenario, mengutamakan10closed/3hari untuk eksplorasi. Syarat promosi tetap30closed/3hari, PnL konservatif positif pada base/delay/fee, risiko lebih baik dan forward100trade/7hari. Kandidat kurang rugi atau abstain tidak menang.

Tidak menyebut periode03:00–03:40Z sebagai data baru lagi. Pilihan loopC ditulis sebelum pemeriksaan data setelah03:40Z. Pemeriksaan berikutnya hanya boleh memakai pilihan dan hash beku tersebut; tidak memilih ulang dari test. Jika training gagal, tetap dilabeli rejected walaupun kemudian ada satu win.

Maksimum jumlah hipotesis kumulatif25 (17 v5b +8 C). Tidak melakukan pencarian threshold lanjutan tanpa protokol versi lain dan periode baru.
