# Codex online forward engineering loop v17

4 Oktober2026. Satu prosedur online tambahan,71→72keluarga hipotesis; initial action-value config dipilih TRAIN v15, bukan dipilih ulang dari AUDIT. Tidak mengubah AGY/config/collector/dashboard/service dan tidak mengirim order/network request. Loop melakukan fresh rule replay dari capture yang terus ditulis collector existing, **bukan live order execution atau quote-exact paper fills**.

## Formula yang diperbarui secara kausal

Native opportunity yang sama dibandingkan pada enam policy: AGY_NATIVE, AGY_REFERENCE, PEAK_RECHECK_V10, NORMALIZED_BREADTH_V16, ACTION_VALUE_FIXED_V15, ACTION_VALUE_ONLINE_V17. Config masing-masing sudah dipilih dari historical TRAIN. Tidak membandingkan Codex latency cepat dengan AGY latency lambat.

V17 memakai config/3action/min24history/min8leaf/shrink8/gain0,02/positive threshold$0,04 persis v15. Pada opportunityAt t, setiap head fit hanya shadow label dari7hari sebelumnya, signalAt≥t−7hari dan availableAt<t, dedupe mint/24h. Actions DIRECT_PEAK/FULL750_PEAK/FULL1500_PEAK; predicted action-value tertinggi>$0,04, lainnyaWAIT. Labels sama v15:BASE net model; future fill/capture belum selesai tidak masuk. Initial seed seluruh historical labels v15 yang sudah tersedia sebelum freeze. Seluruh future decisions, model hash dan resolved-label count dipertahankan. Hyperparameter/config tidak diseleksi ulang dari future. Updating learned tree sesudah outcome tersedia adalah bagian prosedur yang dibekukan ini, bukan hindsight optimization. Predictor masih heuristik, bukan calibrated probability.

## Waktu, penyimpanan, dan comparison

Mulai paling awal4Oktober15WIB (08:00UTC), di-round-up ke boundary30menit setelah manifest freeze jika coding terlambat. Seluruh policy memakai start global sama. Snapshot setiap30menit, cumulative dari start tetap. Embargo latest180s; pending observations terbawa, tidak dibuang pada setiap batas interval. Mint-first-seen purge/universe dan one attempt/mint24h sama control/challenger. Tidak menjumlahkan cumulative snapshots. Portfolio satu posisi/cooldown/dayloss terus dihitung sejak start dan tetap blocked pada unknown, bukan reset per snapshot.

Source processed setelah detail berumur≥180s; prepared data tetap maksimal180s dan actual/inferred captureEnd, tidak diperpanjang berdasarkan keuntungan. Cases yang punya native signal disimpan sekali dengan hash; compactcontext seluruh monitored detail disimpan sekali per-session. Semua replay input yang sudah finalized dipertahankan ketika raw lama dibersihkan. Context untuk v16 memakai lookback15menit dan strict eventAt<t/exclude target. Universe earliest seen dari stored historical metadata dan event yang tersedia; coverage/missing raw dicatat, tidak direkonstruksi. Adding future cases tidak boleh mengubah model/action decision yang sudah dicatat; prefix regression diperiksa.

Registry hash seluruh sumber/model-selections/protocol/protected files. Source berubah→stop dengan status, tidak diam-diam rerun old records memakai rules baru. Lock process mencegah duplicate runner. Resource ceiling512MiB artifacts baru dan minimal2GiB disk free. Maksimal7hari per run, lalu berhenti dengan hasil belum tuntas jika kriteria belum dipenuhi; tidak menandai sukses karena waktu habis. Tidak menghapus raw/userdata. Hanya temporary owned lock dibersihkan ketika exit. SIGINT/SIGTERM menghentikan runner sendiri, bukan service AGY.

## Kapan ada kandidat formula bagus?

Status PROMISING_FORWARD_REPLAY hanya jika challenger mencapai≥100closed pada≥7hari WIB, conservative PnL>0 dan lebih baik kedua controls pada BASE/delay2s/fee2%, unknown0, tailloss/drawdown tidak lebih buruk; portfolio challenger juga tidak blocked dan PnL positif serta lebih baik kedua controls. Ini bukti paper-model dari data baru, **bukan izin live atau klaim swap sebenarnya akan fill**. Execution evidence/quote/receipts tetap wajib sebelum deployment. Zero-entry, satuwin atau risiko control yang hanya akibat missingdata tidak cukup untuk klaim live outperform. Status belum lulus tetap explicit.

Loop ini otomatis memperbarui *formula tree yang dipelajari* dan menguji fixed-policy controls pada data baru. Tidak menjalankan parameter sweep tanpa batas pada historical audit. Uji pertama menunggu window30menit baru benar-benar selesai; `--once` tidak boleh membaca future window. Status/PID/nextCutoff/ledger/model hashes tersimpan di `reports/codex-online-forward-v17/`. Tidak ada service systemd/cron atau AutoBuy baru yang dipasang.
