# Profit4 paper monitor

`npm run dashboard:profit4` membuka dashboard di http://127.0.0.1:4176. Start/Restart menjalankan `scripts/run-profit4-watch.mjs`; CLI juga tersedia lewat `npm run wallet:profit4-watch`. Gunakan satu worker pada satu waktu. Chrome terlihat, memakai profil login `research-aria-tele01/Profile 12` yang sudah ada. Worker distribusi lama harus berhenti karena profilnya sama.

Rules satu putaran mengikuti kandidat cap4: observasi30s, minimal30s setelah transfer, monitor terlambat maksimal15s, batas entry180s dari quote pertama, buy-share5s>=50%, buy bermakna5s>=USD5, >=1buyer, holder count/growth15s fresh dan tidak turun, momentum0.3–5%, drawdown<=5%, rise<=15%, tanpa sell>=USD250. Entry diperiksa lagi pada quote setelah latency>=1s. Target4% bersih dihitung via policy cap4, stop5% bersih, hold300s; tidak ada trailing atau exit flow tambahan.

ModalUSD5, model biaya1%/sisi, slippage0.5%/sisi, biaya tetapUSD0.005/sisi. PnL adalah paper berbasis harga socket, bukan swap route atau fill nyata. Stop tidak menjamin loss maksimal5%. Putaran kedua tidak dijalankan. Ledger `bought-mints.json` mencegah entry ulang pada mint yang pernah dibeli, termasuk sesudah restart.

Wallet default diambil dari daftar dashboard distribusi saat pembuatan konfigurasi Profit4. Edit/tambah/hapus lewat satu tabel; Simpan & restart menerapkan perubahan dan memberi peringatan posisi terbuka menjadi exit kurang data. Satu controller fetch aktivitas semua wallet secara bergantian dengan jeda500ms, maksimal satu detail per wallet. Detail tetap merekam setelah paper sell, sampai wallet asal sell, diganti transfer baru, atau worker berhenti.

Log API, raw socket, transaksi token dan event paper berada di `data/profit4-watch/<run>/chunks/<WIB-window>/`, partisi30menit. Snapshot per sesi `profit4-state.json`; kontrol/PID di `worker-control.json`; log proses `worker.log`. Respons HTML/non-JSON disimpan dan polling ditandai gagal. HTTP429 memakai backoff15/30/maksimal60detik; socket tetap direkam. Dashboard memisahkan PnL selesai, estimasi posisi terbuka, dan exit kurang. Hasil paper historis lama ditampilkan terpisah.

Rules masih eksperimental; perubahan biaya aktual dan latency dapat mengubah hasil. Worker tidak memiliki alur pengiriman order, private key, atau transaksi live.
