# Validasi tambahan aturan same-entry yang tetap

Dibekukan 4 Oktober 2026 sebelum membaca hasil periode tambahan. Ini bukan versi strategi baru dan bukan pemilihan ulang parameter.

- Periode: 3 Oktober 19:55 WIB sampai 4 Oktober 10:00 WIB (`2026-10-03T12:55:00Z` sampai `2026-10-04T03:00:00Z`).
- Kandidat utama tetap `CODEX_TREND`, hasil ranking training sebelumnya. Status training sebelumnya **rejected** tetap berlaku; hasil baru tidak menghapus kegagalan tersebut.
- Enam exit dan tiga skenario eksekusi tetap sama dengan `CODEX_SAME_ENTRY_EXIT_PROTOCOL.md`. Tidak mengubah entry, exit, biaya, slippage, atau batas risiko setelah membaca periode baru. Semua buy harus identik antarexit.
- Purge mint yang terlihat sebelum awal periode dari universe laporan beku maupun metadata sumber yang masih tersedia. Satu percobaan/mint/24 jam; embargo 180 detik terakhir; tidak mengambil sell setelah cutoff.
- Temukan sumber melalui timestamp `DETAIL_STARTED`, bukan hanya nama direktori. Arsip yang sudah dihapus dicatat, tidak dipulihkan dan tidak dianggap sebagai sumber kosong yang lengkap.
- Periksa hash implementasi/protokol terhadap laporan lama sebelum replay. Simpan metadata ukuran/mtime sumber sebelum dan setelah membaca agar perubahan capture terlihat. Ini bukan snapshot byte-exact; perubahan yang menyentuh observasi lama harus diaudit sebelum reproduksi dianggap identik.
- Keluaran terpisah `reports/codex-same-entry-overnight-replay.json` dan `reports/codex-same-entry-overnight-summary.json`; laporan awal tidak ditimpa. Ledger menyimpan seluruh outcome; ringkasan hanya agregat.
- Laporkan win/loss, buy gagal, unresolved, PnL diketahui, batas konservatif, perbedaan paired, stress, dan portofolio satu posisi. Ringkasan jam hanya deskriptif, tidak digunakan untuk memilih exit.
- Syarat promosi tetap: lolos training, PnL positif dan keunggulan paired/risk konsisten, lalu minimal 100 trade forward pada 7 hari. Periode ini sendiri tidak cukup. `liveAllowed=false` tanpa perubahan konfigurasi, service, atau sumber AGY.

Data socket bukan receipt swap: model harga/biaya yang sama dipakai untuk perbandingan, bukan klaim fill on-chain pasti tersedia. Unknown tidak dihitung sebagai win/loss terealisasi. Selisih dua batas konservatif bukan batas matematis keuntungan paired yang belum diketahui.
