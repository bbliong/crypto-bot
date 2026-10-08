# Codex Cost Recheck v13 — empat hipotesis lanjutan

Dibekukan 4 Oktober 2026 sesudah hasil v12, sebelum outcome v13 dihitung. Parent lambda0,25 dipilih v12 dari TRAIN; tidak memilih parameter berdasarkan AUDIT. Empat konfigurasi baru, total keluarga55→59. Tidak ada modifikasi AGY/live/collector/service.

Alasan TRAIN-only: v12 score momentum rata-rata+3,82 poin tetapi net pada horizon terukur−3,92%; lima dari sepuluh trade berbalik. Penyangga volatilitas bukan estimator profit terkalibrasi. Ini bukan alasan menyesuaikan slope agar cocok pada sepuluh contoh itu. Uji operasional berbeda: setup harus masih layak pada pemeriksaan sebelum submission, dengan tambahan waktu nyata dan kemungkinan kehilangan pemenang.

Universe/input/cohort/bound/as-of/biaya/portfolio sama v12; input cached hanya sesi yang menghasilkan sinyal di v12, karena v13 merupakan perubahan eksekusi atas sinyal v12, bukan entry independen baru dari sesi tanpa sinyal. Tidak mengklaim seluruh capture punya data lengkap. Parent input fingerprint dan case-file hashes wajib cocok. TRAIN/AUDIT historis sudah dieksplorasi, bukan holdout.

Tepat empat hipotesis: wait750/1500ms × exitPEAK_CONTROL/TEMPO. Pada frame pertama ≥signalAt+waitMs dan≤target+250ms, jalankan costTempoSetup dengan lambda0,25, SOL/USD opportunity dibekukan. Tidak memilih frame terbaik. Jika tidak layak/missing, SKIP sebelum order, biaya0 dan alasan tercatat. Jika layak, order hanya dibuat di frame tersebut. Batas harga total tetap signalPrice/(1−0,09), tidak di-reset karena penundaan. Jika future modeled fill melewati batas, BUY_FAILED membayar modeled failed fee, bukan free cancellation. Tambahan wait diikuti latency1s/2s biasa. Tidak membatalkan buy setelah sudah fill. Kedua exit persis v12, tanpa threshold tambahan.

Bekukan selection TRAIN sebelum agregasi AUDIT. Ranking/risiko/promosi identik v12: diagnostic≥10closed/3hari, ranking minimum conservative PnL tiga skenario; sample promotion≥30closed/3hari, positif dan mengungguli keduaAGY tanpa memburuk drawdown/tail/unknown; ≥100trade/7hari forward tetap wajib. Null jika tidak ada kandidat aktif. Sinyal SKIP tidak dihitung sebagai win/closed. Seleksi bukan izin live.

Forward hanya setelah selection timestamp dan paling awal07:00 UTC (14:00WIB); periode yang pernah dibaca tidak disulap menjadi holdout. Tidak menimpa laporan v12 atau protokol lama. Detail semua alasan/fill/unknown disimpan; konteks percakapan hanya ringkasan.
