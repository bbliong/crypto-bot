# Scenario Transaction Timeline & API Inspector Guide

Dokumen panduan teknis implementasi halaman **Detail Transaksi & Timeline API per Koin** untuk **Skenario 4** dan **Skenario 6** pada Dedicated Wallet Follower di `cr.bbliong.io`.

---

## 1. URL & Endpoint Publik

| URL | Deskripsi |
| :--- | :--- |
| `https://cr.bbliong.io/add-fol/3scenarios/sce4` | Halaman detail timeline transaksi untuk Skenario 4 ($5 Single Buy, Exit ≥ 15%). Menampilkan koin terbaru secara default. |
| `https://cr.bbliong.io/add-fol/3scenarios/sce6` | Halaman detail timeline transaksi untuk Skenario 6 (Sniper V2: TP1 50% @ 5%, TP2 @ 15%). |
| `https://cr.bbliong.io/add-fol/3scenarios/sce4?token=shegoin` | Detail timeline transaksi spesifik untuk koin `shegoin` di Skenario 4. |
| `https://cr.bbliong.io/add-fol/3scenarios/sce6?token=shegoin` | Detail timeline transaksi spesifik untuk koin `shegoin` di Skenario 6. |
| `https://cr.bbliong.io/add-fol/api/scenarios/timeline?scenario=sce4&token=shegoin` | Endpoint API JSON yang mengembalikan seluruh data 8 step timeline terstruktur & raw request/response. |

---

## 2. Arsitektur Data

Data disusun secara berkala dari 3 sumber:
1. **`follower-real-ledger.jsonl`**:
   - Perekaman kronologis immutable per-event (`SWAP_SIMULATION_BUY_*`, `API_PROBE_BUY_*`, `SWAP_SIMULATION_SELL_*`, `API_PROBE_SELL_*`, `REAL_BUY`, `REAL_SELL`, `RENT_RECLAIMED`).
   - Menyimpan timestamp presisi milidetik, objek `signal` (txHash target, tokenAmount, solAmount, usdAmount), latency quote swap, dan status order GMGN.
2. **`dryrun-3scenarios-live.json`**:
   - Menyimpan status portfolio real-time S4 vs S6, open positions, closed trades (PnL, ROI %, modal terpakai, exit reason).
3. **`wallet-follower-events.json`**:
   - Metadata tambahan event target dan bot.

Modul aggregator di **`scripts/scenarios-timeline-aggregator.mjs`** menggabungkan ketiga sumber tersebut dan menghasilkan output terstandar 8 langkah transaksi.

---

## 3. Rangkaian 8 Langkah Timeline per Koin

Setiap koin yang ditransaksikan dipetakan ke dalam 8 node kronologis:

1. 🟣 **Target Buy Signal Detected** (`TARGET_BUY`)
   - Deteksi whale/target melakukan pembelian koin dari saldo 0 (Apple-to-Apple first buy).
   - Menampilkan: Timestamp WIB, modal SOL/USD, harga entry, link Solscan tx target.
2. 🟡 **Hit API GMGN Get Swap Route (Buy)** (`API_SWAP_BUY`)
   - Meminta rute likuiditas terbaik ke endpoint `/txproxy/v1/get_swap_route`.
   - Menampilkan: Endpoint, parameter query, latency (ms), exchange AMM terpilih (misal `meteora_dammv2`), quote `inAmount` & `outAmount`.
3. 🟢 **Hit API GMGN Submit Swap Order (Buy)** (`API_BUY_SUBMIT`)
   - Mengirim payload order beli ke endpoint `/mrtapi/v2/swap_batch_order`.
   - Menampilkan: Body request JSON, status response HTTP (200 / 400), Order ID, Tx Hash, atau status simulasi terverifikasi.
4. 🔵 **Hit API Solana RPC (Post-Buy Settlement & Sync)** (`SOLANA_VERIFY_BUY`)
   - Memanggil Solana RPC (`getTokenAccountsByOwner` / `getOnChainTokenBalance`) untuk memastikan saldo on-chain riil koin telah mendarat.
5. 🟠 **Target Sell Signal Detected** (`TARGET_SELL`)
   - Deteksi target menjual koin yang memenuhi ambang batas rules skenario.
   - S4: Trigger `CUM_SELL >= 15%` (Full Exit).
   - S6: Trigger `STAGE_1_TP_50% >= 5%` atau `STAGE_2_RUNNER_FULL_EXIT >= 15%`.
6. 🟡 **Hit API GMGN Get Swap Route (Sell)** (`API_SWAP_SELL`)
   - Meminta rute sell ke endpoint `/txproxy/v1/get_swap_route`.
   - Menampilkan: Endpoint, token_in_address, latency, quote SOL yang diekspektasikan.
7. 🔴 **Hit API GMGN Submit Swap Order (Sell)** (`API_SELL_SUBMIT`)
   - Menembak order jual ke `/mrtapi/v2/swap_batch_order`.
   - Menampilkan: Payload request, status response, realized PnL & ROI.
8. 💎 **Hit API Solana (Auto Reclaim Rent SOL)** (`SOLANA_RENT_RECLAIM`)
   - Menutup ATA akun token kosong untuk me-reclaim sewa storage akun Solana (+0.002039 SOL) kembali ke wallet utama.

---

## 4. Inspeksi Request & Response Payload

Di setiap langkah timeline terdapat collapsible accordion:
`📦 Lihat Request & Response API Asli (JSON)`
- Menampilkan exact request payload (Endpoint, Method, Headers, Query/Body).
- Menampilkan exact response payload (Status code, Latency, Response JSON).
- Fitur **Copy JSON** satu-klik.
- Seluruh token rahasia (`Bearer Authorization` dan `Cookie`) terlindungi dan tersanitasi secara otomatis (`[redacted]`).

---

## 5. Pemeliharaan & Integrasi Masa Depan

Jika ada skenario baru (misal Skenario 7 atau strategi lain):
1. Daftarkan metadata skenario di `SCENARIO_META` dalam `scripts/scenarios-timeline-aggregator.mjs`.
2. Daftarkan route handler di `scripts/serve-wallet-follower-dashboard.mjs` (misal `/3scenarios/sce7`).
3. Tambahkan tombol tautan navigasi di `scripts/render-3scenarios-live.mjs`.
