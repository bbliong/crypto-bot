# Loop H / v10: peak native dengan timing recheck

Dibekukan4Oktober2026 sebelum hasil empat kandidat dan outcome06:00–06:30UTC dibaca. Implementasi AGY tidak dimodifikasi.

Diagnosis TRAIN v9: pada AI peak net model21,55% lalu native exit berakhir1,67%. Fungsi native membaca p.peak; caller/harness native tidak memperbarui peak. Kontrol reference v4 mengubah beberapa detail exit/net, sehingga v10 mengisolasi update peak saja dalam wrapper Codex dengan timing baru.

Empat hipotesis: DIRECT_PEAK serta FULL recheck250/750/1500ms dengan PEAK. Recheck, pricebudget, biaya dan fill persisv9. Exit wrapper menyimpan posisi baru dan menaikkanp.peak ke maksimum harga tick yang SUDAH diterima setelahbuy, lalu memanggil fungsi exit native yang sama. Tidak mengubah threshold, approximation3% yang dibaca exit asli, flow condition, atau fee model PnL. Tidak memperbarui peak memakai future fill atau markout setelahexit.

TRAIN54 opportunity sampai3Oktober12WIB; AUDIT29sesudahnya sampai4Oktober10WIB. Rank hanya TRAIN, minimum10closed/3hari eksplorasi dan minimum conservativePnL tiga skenario. Promosi≥30closed/3hari, PnL positif pada base/delay2s/fee2%, unknown/risiko tidak memburuk vs dua kontrol; forward100trade/7hari tetap perlu. Total keluarga kumulatif47.

Simpan pilihan sebelumfresh06:00–06:30UTC dibaca. v8/v9/v10 boleh diperiksa bersamaan pada window tersebut; tidak memilih ulang setelahhasilfresh. PnL in-sample atau satu contoh profit terlindungi tidak membuktikan kemenangan umum. Simpan kontrolnative pada timing/opportunity yang sama untuk mengukur updatepeak secara terpisah.
