# Loop D / v6: entry independen pada seluruh detail tersedia

Dibekukan4Oktober2026 setelah25 hipotesis v5 ditolak, sebelum hasil v6. Jangan mengubah atau menimpa laporan sebelumnya. Tidak ada live trading/perubahan AGY.

Alasan: pada11 opportunity AGE300 di audit, native menghasilkan known PnL+$2,7328 versus harvest+$0,6072, keduanya1unknown. Exit yang lebih cepat bukan sumber kemenangan. Menyaring hanya opportunity yang kemudian dikonfirmasi juga tidak boleh dipakai sebagai filter entry AGY pada waktu sebelumnya (lookahead). Karena itu v6 membentuk sinyal dari prefix data seluruh detail, tanpa syarat bahwa AGY nanti akan masuk.

Universe: seluruh sumber raw tersedia dengan DETAIL_STARTED1Oktober00WIB sampai4Oktober10WIB. Catat setiap source/session, count/no-tick/end inferred; jangan memilih hanya mint yang punya AGY signal. Semua dibandingkan dalam biaya/as-of data adapter bersama, stake$5, base delay1s, delay2s dan fee2% stress seperti v5. Pembanding AGY_NATIVE dan AGY_REFERENCE tetap asli di harness; output rule replay, bukan salinan full-service.

Tepat4 hipotesis: dua entry independen × exit NATIVE/HARVEST dari v5. Tidak ada sweep threshold.

- MATURE_TREND: quality snapshot/freshness/hardgate sama dengan entryQualityV5, umur≥300s, return5 antara0,5–10%, drawdown5≤2,5%, return2>0, buy5≥60%, buy20≥65%, buyer≥4, buyUsd≥300, top buyer≤50%, MC$10k–$100k, holders≥100, top1≤8%, top5≤25%, dev≤2,5%. Bahaya dev sell≥25, major-holder sell+return2≤0, atau crash1s≥8% membatalkan arm.
- MATURE_RECLAIM: quality yang sama, umur≥300s, history≥20s, peak-before-trough dalam10s, rebound10 antara1–4%, drawdown10 antara2–8%, return5 antara−3–8%, buy5≥65%. Konfirmasi pemulihan menggunakan data yang sudah diterima.
- Keduanya wajib dua tick berbeda selama≥500ms. Cari entry hanya pada60s pertama detail; satu setup per profile/detail. Tidak melihat akhir capture saat keputusan. Tidak mengambil posisi lama pada harga sebelum konfirmasi.
- Exit NATIVE dipakai apa adanya pada buy baru; HARVEST mempertahankan native exit, menambah danger/hardnet−6%, floor4→1/trail5 setelah8, maxhold12s. Semua fill memakai delay sebenarnya dan bisa unknown.

TRAIN sebelum3Oktober12WIB; AUDIT3Oktober12WIB–4Oktober10WIB. Keduanya sudah terpakai, berlabel retrospektif. Satu attempt/mint/24h per strategy, mint first-seen sebelum partition dipurge untuk semua. Embargo180s. Cohort sinyal dapat berbeda karena entry berbeda, sehingga agregat bukan paired same-buy. Portofolio satu posisi dilaporkan terpisah dan berhenti pada unknown.

Pilih hanya dari TRAIN. Ranking mengutamakan≥30closed/3hari, kemudian minimum conservative PnL base/delay/fee. Promosi perlu positive absolute PnL, risiko/unknown tidak memburuk, dan hasil lebih baik dari kedua kontrol pada stress; tetap memerlukan100trade/7hari forward. Nol entry atau sekadar lebih sedikit kerugian tidak menang. Total hipotesis kumulatif29.

Simpan input/fingerprint dan keluaran terpisah. Jika semua kandidat gagal, jangan memakai AUDIT untuk memilih ulang. Periode setelah4Oktober10:40WIB (`03:40Z`) tersedia untuk evaluasi frozen baru, tidak untuk pelatihan ulang diam-diam.
