# Auto-buy S14 / S14-Alpha / S15 — tetap OFF

## Scope dan plan
1. Tambah pilihan dashboard, parameter modal, penyimpanan config dan API untuk tiga skenario.
2. Isolasi routing agar S4/S5/S13 Alpha/Beta tidak ikut mengeksekusi S14-family.
3. Gunakan executor bersama; periksa stake, saldo token aktual, partial TP, final exit dan pengaman OFF.
4. Jalankan test offline dan regresi, lalu reload service lama hanya saat konfigurasi real OFF.
5. Verifikasi UI/API/service, catat batas pengujian dan commit hanya file task.

## Ownership
Agy berhenti karena kuota provider setelah menghasilkan perubahan parsial. Hermes melanjutkan langsung sesuai instruksi user, tanpa proses Agy aktif. Review level: IMPLEMENTED_SELF_REVIEWED. Perbaikan setelah takeover mencakup renderer syntax error yang sebelumnya salah dianggap skip-test, guard boolean dan composite, sinkronisasi modal S15/Beta, partial settlement, dan cek ulang OFF sebelum submit.

## Target dan modal
- S14: `S14` → `SCENARIO_14_BUNDLER_RUNNER`; `stakeUsdS14`.
- S14-Alpha: `S14_ALPHA` → `SCENARIO_14_ALPHA_60S_GRACE`; `stakeUsdS14Alpha`.
- S15: `S15` / alias `S14_BETA` → `SCENARIO_14_BETA_HOARDING_DEFENSE`; `stakeUsdS15` / `stakeUsdS14Beta`.
- Default masing-masing $5; tidak mengambil modal dari keluarga strategi lain. Jika kedua key modal S15/Beta dikirim, S15 menang; nilai kedua alias disinkronkan saat save.
- Batas API modal: $0.05–$1000, invalid ditolak HTTP 400. Store meng-clamp numeric stake sesuai batas existing.
- `BOTH` / `ALL` tetap berarti semua strategi, termasuk tiga skenario baru. Composite mendukung `+`, koma, dan whitespace. Campuran dengan OFF/DRY_RUN atau target unknown ditolak.

## Pengamanan dan semantik
- Deployment ini tidak mengaktifkan auto-buy, auto-sell, signing atau broadcast.
- Pemilihan target tanpa `enabled: true` eksplisit tidak mengaktifkan real execution.
- UI menampilkan konfirmasi transaksi nyata sebelum mengirim `enabled: true` atas pilihan operator. DRY_RUN dan OFF selalu mengirim false.
- OFF/DRY_RUN/boolean false menolak order; konfigurasi dibaca ulang tepat sebelum submit untuk menangani OFF saat quote masih berjalan.
- BUY S14-family memakai modal sendiri pada quote dan executor. SELL real wajib ada posisi dengan mint DAN scenario/lane yang sama; saldo token on-chain wajib tersedia.
- Partial Stage 1 menjual separuh base units, mempertahankan HOLDING, remaining balance dan cost basis. Final exit mengakumulasi PnL kedua leg. Retry menjaga rasio parsial, bukan mengubahnya menjadi full sell.
- S14-family tidak memanggil destructive burn fallback. Rent reclaim existing hanya setelah final exit.
- Konfigurasi strategi entry/exit tidak diubah; hanya penyambungan execution dan accounting.

## Test dan batas bukti
- RED nyata setelah takeover: renderer import gagal syntax; 5 contract assertions gagal (boolean, composite, stake isolation, explicit arm, alias sync); dua test helper settlement/slicing belum tersedia; API invalid config awalnya salah HTTP 200.
- GREEN: `node --import tsx tests/test-autobuy-s14-s15-routing.mjs`: 77 assertions (48 routing, 21 store, 8 UI).
- GREEN: `node --import tsx --test tests/autobuy-contract.test.mjs`: 9 tests.
- GREEN: `node --test tests/autobuy-api.test.mjs`: 1 test HTTP server lokal sementara dengan data dir terisolasi, bukan API produksi.
- GREEN: `node --import tsx --test tests/autobuy-worker.test.mjs`: 4 tests menggunakan OFFLINE_FIXTURE; membuktikan 0 submit saat OFF dan saat OFF berubah selama quote. Fixture ini bukan kuotasi pasar riil dan bukan report trading.
- Regresi existing: S14 bundler, S14-Alpha grace, S14-Beta hoarding, render stake inputs, capital config: exit 0. Tiga suite strategi masih mengeluarkan warning ENOENT dari timer yang selesai sesudah cleanup test dir; tidak diklaim output bersih.
- Syntax `.mjs`, import/transpilasi worker via tsx, dan `git diff --check`: PASS.
- Full TypeScript typecheck: BLOCKED oleh lifecycle guard karena dependency compiler melebihi batas pemindaian; tidak dicoba bypass.
- Suite lama `test-autobuy-scenario-selection.mjs` TIDAK dijalankan: ia menulis ke config produksi dan mengaktifkan real mode. Digantikan test HTTP terisolasi di task ini.
- Real AMM order, signing, broadcast, burn, rent reclaim dan transaksi berbayar: NOT_EXECUTED, sesuai permintaan tetap OFF.

## Batas aktivasi nyata — belum dinyatakan aman untuk ON
Review read-only yang selesai terlambat mengambil snapshot sebelum patch Hermes terakhir. Readback commit `86a73e9` memastikan partial settlement, ownership berdasarkan scenario+mint, sizing retry, stake S15, final OFF recheck dan larangan burn S14-family sudah terpasang. Temuan itu bukan daftar bug yang semuanya masih aktif.

Namun masih ada gate terpisah sebelum real mode boleh dinyatakan siap:
- Belum ada reservasi/lock atomik per wallet dan per posisi untuk probe paralel, termasuk Stage 1 dan Stage 2 yang dapat terpanggil berdekatan.
- Belum ada durable/idempotent pending-exit recovery khusus S14-family bila route/order gagal.
- Ownership telah diperketat berdasarkan scenario+mint, tetapi belum dibuktikan isolasi wallet/cycle dan bounded allocation pada holding wallet yang bercampur.
- Jalur bersama masih memakai asumsi token 6 decimals serta fallback readiness wallet; perlu fail-closed wallet/decimal verification sebelum aktivasi nyata.
- Semantik autoSell pada shared executor belum diselaraskan dengan legacy lane dan belum diberi defense-in-depth pada adapter submission.

Karena itu acceptance task ini adalah pilihan/config/routing terpasang, paper-only berfungsi, UI publik terverifikasi, dan real mode tetap OFF. Ini bukan sertifikasi live trading. Jangan aktifkan ON sebelum gate tersebut diselesaikan dan diverifikasi secara terpisah; jangan menjalankan transaksi nyata untuk sekadar membuktikan UI.

## Deployment terverifikasi
- Kedua service existing direstart pada 12 November 2026 09:35:49 WIB; wallet follower dan dashboard active/running, NRestarts=0 saat pemeriksaan.
- Journal worker menunjukkan CDP dan WebSocket GMGN terhubung; heartbeat muncul setelah restart.
- Browser existing CDP 9223, context test terisolasi, membuka halaman publik `https://cr.bbliong.io/add-fol/3scenarios/`: HTTP 200, nol pageerror.
- DOM publik: ketiga radio `S14`, `S14_ALPHA`, `S15` terlihat, semuanya unchecked; yang checked `DRY_RUN`.
- DOM publik: masing-masing input `s14StakeInput`, `s14AlphaStakeInput`, `s15StakeInput` hanya satu dan bernilai 5.00.
- Readback API lokal `/api/autobuy/status`: `{ "ok": true, "enabled": false }`.
- Readback config disk sesudah deployment: enabled=false, autobuyScenario=DRY_RUN, autoSell=false.
- Tidak ada log submit real sejak restart dalam jendela verifikasi. Mode nyata tidak diaktifkan untuk pengujian.
