# Amendemen kelayakan data v5b

Dibekukan 4 Oktober 2026 sekitar 10:43 WIB, sebelum ranking kandidat dengan training Oktober. Formula kandidat v5 tidak berubah.

Percobaan v5 pertama menemukan 46/133 sinyal kehilangan sumber raw, termasuk SELURUH 39 sinyal training sebelum1Oktober. Dataset matched berisi87 sinyal. Ranking pada training kosong bukan seleksi sah: pilihan seri DIRECT_NATIVE_ALL hanyalah kontrol identik AGY, tidak boleh dinamai lane Codex unggul. Output v5 asli dipertahankan sebagai catatan kegagalan kelayakan data. Pemeriksaan10:00–10:30WIB sudah terbaca dalam percobaan itu (1sinyal), sehingga tidak lagi disebut holdout baru.

Perbaikan metodologi, bukan retuning profit:

- Pakai cache raw terurai v5 yang tersimpan, periksa hash dependency pembentuk frame dan identitas sinyal; hindari ketergantungan pada raw yang bisa dibersihkan lagi. Cache bukan rekonstruksi sumber September yang hilang.
- TRAIN: semua available capture sebelum3Oktober12:00WIB (`2026-10-03T05:00Z`), meliputi1–3Oktober; semua periode tersebut pernah dilihat dan berlabel development retrospektif.
- AUDIT:3Oktober12:00WIB sampai4Oktober10:00WIB (`2026-10-04T03:00Z`), purge mint lama. Tidak memperluas audit melewati snapshot historis.
- Pemeriksaan baru10:30–10:40WIB (`03:30–03:40Z`), diproses hanya setelah pilihan TRAIN ditulis. Sepuluh menit jelas bukan validasi cukup; nol trade tidak menang.
- Keempat timing entry, tiga exit, enam gate tahapB, biaya dan ranking tetap persis v5. Total17 hipotesis unik; tidak ada threshold tambahan.
- Nilai SOL/USD untuk entry tertunda memakai nilai as-of saat opportunity AGY, maksimal keputusan tertunda12s. Ini asumsi eksplisit, bukan quote valuta baru.
- Semua syarat sampel/promosi v5 tetap. Eksplorasi10closed/3hari bukan pengganti syarat≥30closed, PnL/stress/risk positif dan forward100trade/7hari. Tidak ada perubahan AGY/live.

Keluaran memakai prefix `codex-engineering-v5b`, tidak menimpa hasil v5. Jika TRAIN kosong, runner harus berhenti sebelum ranking/akses periode baru.
