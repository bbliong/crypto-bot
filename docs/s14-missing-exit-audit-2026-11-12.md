# Audit posisi S14-family tanpa final SELL

## Scope dan hasil
Pemeriksaan read-only 12 November 2026, 10:51–10:53 WIB. Tidak mengubah config, state posisi, service, maupun mengirim order.
Status: BUG monitoring terkonfirmasi; likuidasi tidak tersedia pada probe yang diuji; waktu rugpull on-chain belum diverifikasi.

## Bukti runtime
- Worker active/running, NRestarts=0. Bukan service mati.
- Pada 10:51:23 WIB, posisi X berumur sekitar 64–65 menit; Osaru sekitar 36 menit, masih OPEN pada S14, Alpha dan S15.
- Journal sejak 10:15:00: Osaru disubscribe 35 kali dan di-unsubscribe 36 kali; subscription terakhir berupa unsubscribe. Aktivitas whale terakhir yang tertangkap 10:32:29, BUY.
- Tidak ada raw whale event X dalam jendela journal sejak 10:15:00.

## Root cause kode yang diperiksa
1. `scripts/run-wallet-follower.ts:1331-1352`: allOpenMints hanya menggabungkan posisi Lane 1, Lane 2, dan Gen2 cooldown. Posisi terbuka khusus multiDryRunEngine tidak dimasukkan. Akibatnya pruning dapat melepaskan subscription token yang masih dipegang S14-family.
2. `scripts/run-wallet-follower.ts:1383-1386`: fallback batch harga memanggil lane.updateTokenTick dan handleSmartDipPriceTick, tetapi bukan multiDryRunEngine.updatePriceTick. Sekadar mengambil harga tidak memperbarui evaluator skenario multi.
3. `src/multi-scenario-dryrun-engine.ts:4351-4366,4392-4406`: timeout 30 menit berada di handler target SELL, bukan sweep independen waktu. Jika target berhenti menjual, timeout tersebut tidak dievaluasi.
4. `src/multi-scenario-dryrun-engine.ts:4993-4998`: daftar checkStagnantPositions hanya s4 sampai s9, bukan S14-family. Sweep ini tidak melindungi posisi tersebut.

## Probe AMM read-only, 10:53:43–10:53:45 WIB
Browser GMGN existing CDP localhost; GET token_info dan get_swap_route saja. Tidak ada submit, sign, burn atau close account.
- Metadata mint diverifikasi sama persis, decimals keduanya 6; jumlah quote berasal dari sisa token paper S14.
- Osaru: 2/2 SELL quote gagal, `little pool hit (v2)`.
- X: 2/2 SELL quote gagal, `little pool hit (v2)`.
- Probe pertama menggunakan pairAddress tersimpan. GMGN mengembalikan biggest_pool_address alternatif, yang kemudian juga diuji pada 10:54:52–10:54:54 WIB: X dan Osaru masing-masing gagal 2/2 lagi dengan `little pool hit (v2)`. Kedua pool yang diketahui telah diperiksa, bukan seluruh venue di blockchain.
- Metadata liquidity GMGN sangat kecil, tetapi unit field tidak diverifikasi independen dalam audit ini.
- Readback real config: enabled=false, autoSell=false.

Raw: `data/reports/token-health-1794455625034.json`.

## Dampak terhadap report
Angka 3 win/0 loss adalah closed trades saja. Sisa posisi OPEN yang macet tidak boleh dianggap sehat, profitnya belum tentu dapat dicairkan, dan kerugian akhirnya belum tercatat. Profit total/cash sesi belum final karena accounting juga belum rekonsiliasi.
Tidak boleh memalsukan SELL pada harga lama atau mengembalikan modal ke $5. Failed quote bukan executed loss atau bukti waktu LP drain. Tandai EXIT_UNAVAILABLE/STALE_OPEN dalam report sampai ada bukti lebih lanjut.

## Perbaikan yang belum dilaksanakan dalam audit ini
- Satukan daftar seluruh mint open multi-scenario dengan subscription dan fallback price evaluation.
- Tambahkan sweep timeout independen target events, dengan actual quote guard sebelum settlement.
- Tangani persistent exit intent dan unavailable liquidity tanpa memalsukan SELL/cash.
- Audit rehydration tracker setelah restart serta accounting secara terpisah.
