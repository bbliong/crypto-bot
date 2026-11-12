# AP1/AP2/AP3 — satu BUY per mint

## Kontrak dan rencana

1. Reproduksi BUY → exit → feed `isFirstBuy=true`/ground-zero untuk mint yang sama.
2. Tutup bypass pada evaluator AP1/AP2/AP3 dan jalur `processScenarioBuy`.
3. Verifikasi restart, posisi terbuka/partial TP, callback, kas/fee, dan mint berbeda.
4. Commit perubahan terisolasi; tidak restart/deploy atau menjalankan transaksi.

Kunci identitas adalah **mint/CA persis**, bukan simbol. Maksimal satu entry per mint **di masing-masing AP**, bukan satu entry global lintas AP. AP1 tidak menghalangi entry pertama AP2/AP3. Simbol sama dengan mint berbeda tetap eligible.

## Akar masalah yang diverifikasi di kode

Evaluator S14 memakai `allowReEntryCycle: true` untuk entry post-whale. Flag tersebut juga melewati pemeriksaan `closedTrades` pada jalur BUY umum. AP2/AP3 tidak memiliki guard riwayat tambahan. Tracker `hasEntered` hanya in-memory, sedangkan `closedTrades` disimpan ke disk: setelah restart tracker baru bisa menerima FIRST_BUY ulang.

Sebelum task, terdapat dirty patch guard AP1-only. Maksudnya dipertahankan/diperluas, bukan dibuang. File untracked lain tidak dimasukkan commit.

## Perubahan

- Evaluator AP1/AP2/AP3 menolak mint di `closedTrades` dan mencegah duplikasi posisi terbuka sebelum membuat entry.
- Penolakan tercatat sebagai `SKIP` dengan reason `REJECT_ALREADY_TRADED`; evaluator menyimpan event ke state.
- `processScenarioBuy` menolak riwayat closed mint walaupun `allowReEntryCycle=true`.
- Posisi AP yang masih terbuka tidak boleh diakumulasi walaupun caller mengirim `disallowAccumulation=false`.
- Flag post-whale tetap dipertahankan agar entry PERTAMA yang sah tidak rusak. Tidak ada perubahan batas umur, stake, bundler, whale policy, atau exit.

## Bukti eksekusi

Semua pengujian bug ini memakai fixture offline, bukan kuotasi AMM atau hasil trading/PnL riil.

- RED awal Agy: 10 test, 6 pass / 4 fail, termasuk re-buy AP2 setelah restart. Log: `/home/bbliong/.hermes/cache/scratch/ap-no-rebuy-red.log`.
- RED tambahan Hermes: 13 test, 10 pass / 3 fail; common BUY masih bisa mengakumulasi ketika flag dibuat permisif dan fixture punya kas cukup. Log: `ap-no-rebuy-common-red.log` pada direktori scratch yang sama.
- GREEN final: `node --import tsx --test tests/ap-single-buy-no-rebuy.test.mjs` → **13 pass, 0 fail**. Termasuk restart ketiga AP, callback/kas/fee, partial TP yang benar-benar terjadi, dan guard common BUY.
- Harness terpisah Hermes → **18 checks PASS** untuk ketiga AP: open guard, reset tracker, restart replay, direct common bypass, event tersimpan, mint berbeda/simbol sama. Bukti: `ap-no-rebuy-independent-final.json` di scratch.
- Routing/config/UI: `test-autobuy-s14-s15-routing.mjs` → **83 pass, 0 fail**.
- `test-scenario-14-beta-hoarding-defense-logic.mjs` → exit **0**; test lama mengeluarkan warning cleanup timer/ENOENT.
- Dua test lama bundler/alpha → exit **1** karena assertion nama skenario. Dijalankan ulang terhadap source HEAD sebelum patch di shadow scratch: failure yang sama, bukan akibat fix ini.
- `npm run typecheck` → exit **2**, **25 diagnostic**. Pembanding baseline HEAD di shadow scratch juga 25 dan diagnostic identik setelah normalisasi nomor baris; **tidak ada diagnostic baru**. Bukti: `ap-no-rebuy-typecheck-comparison.json`.
- Full `npm test`: **PARTIAL / tidak hijau**. Run pertama timeout 120 detik. Run bounded berikutnya dihentikan setelah 45 detik dan menunjukkan failure di area lain; tidak diklaim lulus atau seluruhnya baseline. Log tersimpan sebagai `ap-no-rebuy-final-suite.log`.

Agy berhenti karena kuota sebelum docs/commit. Hermes memastikan writer sudah tidak aktif, memperkuat test/guard common BUY, menjalankan verifikasi di atas, dan memfinalisasi. Review level: **Agy partial + Hermes takeover; IMPLEMENTED_SELF_REVIEWED** untuk penguatan final.

## Batas perlindungan dan deployment

- Riwayat `closedTrades`/`openPositions` bertahan restart biasa. **Menghapus/reset riwayat bukan restart**: guard berbasis riwayat tidak bisa mengenali mint historis yang catatannya sudah hilang. Tidak ada klaim blacklist permanen lintas penghapusan data.
- Pemeriksaan read-only state aktif menemukan CA `F98d9RHir1UGqCgVAtbNc2EsQNqGF5txyJq9PNqoVuE2` tidak tercatat di open/closed ketiga AP saat diperiksa. Tidak dilakukan backfill/blacklist live untuk CA itu.
- Kronologi harga/kerugian yang diberikan user tidak diaudit on-chain dalam task ini.
- **Tidak ada restart, deploy, perubahan konfigurasi live, transaksi, signing, broadcast, atau push.** Source baru belum diklaim aktif pada proses bot yang sudah berjalan.
