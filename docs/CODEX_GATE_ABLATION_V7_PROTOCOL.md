# Loop E / v7: pengaruh gate dipisahkan dari exit

Dibekukan4Oktober2026 sebelum membaca hasil kandidat di bawah dan outcome periode04:00–06:00UTC. Tidak mengubah AGY atau ledger lama.

Diagnosis: seleksi berurutan v5b memilih HARVEST terlebih dahulu, baru gate. Audit AGE300 menunjukkan native pada kesempatan yang sama lebih baik daripada harvest. Maka gate harus diuji dengan native/guard secara langsung. v6 terlalu sedikit transaksi untuk ranking yang berguna; kandidat zero-entry ditolak.

Tepat4 hipotesis tambahan: DIRECT × NATIVE/GUARD × AGE300/SIGMA_MAX3. Threshold, biaya dan fungsi gate sama dengan v5. Total kumulatif33. Tidak ada threshold baru atau sweep kombinasi tanpa batas. Formula NATIVE sengaja sama dengan pembanding agar pengaruh gate jelas.

Dataset training/audit tetap cache v5,54 opportunity TRAIN sampai3Oktober12WIB dan29 AUDIT sesudahnya sampai4Oktober10WIB setelah purge. Keduanya development/audit retrospektif. Ranking hanya TRAIN, minimum10closed/3hari untuk eksplorasi, score=min conservative PnL base/delay2s/fee2%. Tidak memilih kandidat zero-trade. Promosi tetap≥30closed/3hari, PnL positif pada seluruhstress dan tidak memperburuk unknown/risiko terhadap kedua kontrol. Training gagal tetap rejected.

Pemeriksaan baru04Oktober11:00–13:00WIB (`04:00–06:00Z`), seluruh detail tersimpan dipindai setelah selection JSON ditulis. Gunakan first-seen mint purge, satu attempt/mint/24h, embargo180s dan cutofffill. Hasil periode baru tidak dipakai memilih ulang kandidat. Simpan kontrol AGY_NATIVE, AGY_REFERENCE, serta satu pilihan training. Laporkan SKIP, exposure, known PnL, unknown dan konservatif secara terpisah, termasuk portofolio yang terblokir.

Kandidat berlabel Codex adalah gate wrapper terpisah di atas opportunity/exit yang ada; memakai native exit tidak berarti sumber AGY diedit. Gate yang menghindari banyak loss tetapi profit absolut masih negatif belum memenuhi target kemenangan. Dua jam bukan pengganti forward100trade/7hari.
