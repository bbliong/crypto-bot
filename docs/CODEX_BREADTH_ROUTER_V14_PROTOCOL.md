# Codex breadth router v14 — frozen protocol

4 Oktober 2026, sebelum perhitungan hasil v14. Empat konfigurasi baru, total keluarga hipotesis59→63. Tidak mengubah source AGY, config live, collector/dashboard/service, atau mengirim transaksi.

Hipotesis: keselamatan satu token tidak cukup jika banyak token lain dalam sampel detail bot sedang dump. Context di sini hanya recent monitored cohort, bukan indeks seluruh pasar crypto. Tidak memasukkan outcome/future survival/harga setelah waktu keputusan.

## Market context as-of

Scan seluruh detail raw tersedia dari1Oktober00WIB sampai4Oktober10WIB, bukan hanya token yang kemudian punya sinyal. Shared received/as-of tick adapter dan frames250ms. Emit context pada tick berbeda dan price fresh≤750ms jika frame ready atau ada dump. Ready sama tape adapter: anchor5s valid dan≥4bucket detik. Dump ialah return2≤−8% atau collapse1s≤−8%. Weak ialah buy5<50% dan return2≤0, keduanya finite. Record saat readiness/weak/dump berubah, saat dump terdeteksi, atau refresh paling sedikit5s pada tick baru. Refresh bukan socket heartbeat.

Reducer per mint menyimpan readyAt, lastObservationAt, lastDumpAt dan lastWeak. Snapshot hanya memproses event dengan eventAt **< opportunityAt**. Context memakai mint dengan readyAt pada15menit sebelumnya; mint sendiri selalu dikeluarkan. DumpRate adalah fraction mint tersebut yang punya lastDumpAt dalam15menit; weakRate berdasarkan last observed state. Dedupe mint lintas sesi/source; event simultan digabung konservatif (OR). Tidak menggandakan denominator karena repeated detail. Sampel lama bukan quote real-time dan selection bias dinyatakan. Minimal20mint; jika kurang, context UNKNOWN, bukan HEALTHY.

## Tepat empat router

Dump cap10%/20% × healthy action FAST/CHECKED. UNKNOWN: FULL recheck1500ms. RED dumpRate≥cap: SKIP tanpa order. AMBER dumpRate≥cap/2 atau weakRate≥50%: FULL recheck1500ms. HEALTHY: FAST direct peak-tracked exit, CHECKED FULL recheck750ms. Tidak menggunakan jam kalender sebagai override. Exit selalu adapter peak v10; existing source AGY tidak disentuh. Context dibekukan di opportunity awal, tidak diubah berdasarkan hasil replay atau biaya stress. Recheck memakai waktu/price budget model v9/v10; latency1/2s dan total price budget asli tetap dihitung.

Native opportunity cohort dan immutable prepared cases v5b (TRAIN54/AUDIT29) dipakai bersama kontrol asli. Context scan dapat memuat token tanpa entry, tetapi tidak menciptakan entry hindsight. Hist TRAIN sebelum3Oktober12WIB; AUDIT sampai4Oktober10WIB, keduanya sudah dieksplorasi. Selection TRAIN sebelum AUDIT aggregation, min10closed/3hari untuk diagnostic ranking, kemudian min conservative PnL tiga skenario. Primary null jika semua tidak aktif. Promosi≥30closed/3hari, positif absolut dan lebih baik dari native/reference pada base/delay2s/fee2% tanpa memburuk unknown/tail/drawdown. Tetap membutuhkan≥100trade/7hari forward; nolentry bukan kemenangan.

Simpan compact context events/fingerprint/inventory terpisah per-source dengan output exclusive. Source yang raw-nya sudah dihapus tidak direkonstruksi diam-diam. Input kasus replay disimpan lebih dulu dari raw yang kini hilang, bukan raw lengkap. Portfolio satu posisi mempertahankan unknown sebagai blocked; event aggregate bukan equity live. Forward mulai sesudah selection dan paling awal4Oktober14:30WIB (07:30UTC), bukan membaca test untuk memilih ulang. Cadangan waktu7:00–7:30 hanya untuk kandidat sebelumnya yang sudah frozen, bukan test baru router ini.
