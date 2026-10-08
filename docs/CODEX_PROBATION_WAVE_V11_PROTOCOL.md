# Loop I / v11: probation setelah buy

Dibekukan4Oktober2026 sebelum hasil empat kandidat dan sebelum outcome fresh06:00–06:30UTC dibaca. Source AGY dan versi Codex sebelumnya tetap sama.

Basis entry: FULL recheck1500ms v9, dipilih dari training sebelumnya. V10 peaktracking meningkatkan knownPnLTRAIN−$0,7342→−$0,3970 tetapi belum positif; banyak loss tidak pernah memiliki peak net positif. v11 menguji pelemahan segera setelah buy dan floor monoton.

Empat hipotesis: probation3/5s × floor NATIVE/EARLY. Tidak ada sweep threshold lain. Waktu probation dari actual modeledbuy; tidak melihat durasi capture.

Semua kandidat menggunakan native peak yang sudah diterima, native exit, hardnetactual−6%, devsell≥25/30s, majorholder sell+return2≤0, crash1s≥8%, gap price>10s. Native floor berdasarkan aturan AGY (approximation3% tetap) diratchet monoton untuk mencegah turun pada transisi tiertrail. EARLY menambah floor peakactualnet≥2%→0,5%; floor ini juga monoton.

Probationexit: pada held≤3/5s, net memburuk≥1percentagepoint dari initial all-in net, buyshare2≤50%, return2<0, sell5≥$100 dan≥2seller; dua tick berbeda terkonfirmasi selama≥250ms, freshprice≤750ms. Weakstate reset ketika bukti fresh membaik atau probation habis. Emergency/floor mengalahkan probation; tidak menunda exitnative. Floor bukan jaminan harga fill.

Biaya, orderdelay, totalpricebudget, TRAIN54/AUDIT29 dan pemisahan waktu sama denganv9/v10. Pilihan hanya TRAIN, minimum10closed/3hari eksplorasi; eligibilitypromosi≥30closed/3hari, positivePNL seluruhstress, risiko/unknown tidak memburuk. Total hipotesis keluarga51. Tambahan mekanisme keselamatan/floor dinyatakan bersama; jangan mengklaim paired effect hanya berasal dari probation.

Freeze selection sebelum06:00–06:30UTC dibaca. Periode fresh boleh membandingkan v8/v9/v10/v11 sekaligus; tidak fitting ulang atau memilih pemenang dari fresh. Training rejection tetap berlaku. Perlu forward100trade/7hari untuk klaim lebih luas/live.
