# Pemeriksaan tambahan pilihan beku engineering

Dibekukan sebelum membaca outcome4Oktober2026 10:40–11:00WIB (`03:40–04:00Z`). Ini replay data tersimpan yang belum dipakai memilih kandidat, **bukan** forward-paper live100trade/7hari.

Bandingkan AGY_NATIVE, AGY_REFERENCE dan pilihan TRAIN dari v5b/v5c/v6. Pilihan diambil dari selection JSON beserta hash yang sudah dibekukan sebelum membaca periode ini. Tidak memilih ulang pemenang dari hasil periode20menit tersebut. Status training gagal tidak dihapus oleh satu/dua win baru.

Entry v5b/v5c memakai opportunity AGY, dapat SKIP/tunda; v6 membentuk entry independen dari seluruh detail. Replikasi biaya/fill/latency sama. Cohort per lane: satu attempt/mint/24h, first-seen mint purge sejak awal window dan embargo180s; tidak ada fill setelahcutoff. Semua detail padawindowdiscan, bukan cuma mint yang menghasilkan sinyal. Jangan mengira entry antarstrategi identik.

Runner tidak boleh membaca cutoff yang belum terjadi. Simpan output file baru dengan exclusive create, tidak menimpa pengujian sebelumnya. Tulis win/loss/unknown/skip, PnL diketahui dan batas risiko, stress, portofolio yang blok saat unresolved. Tidak ada perintah live, daemon, perubahan config, atau promosi otomatis.
