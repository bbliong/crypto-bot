# Dokumentasi Alur Data & Arsitektur Hubungan File (Crypto Bot Wallet Follower)

Dokumen ini menjelaskan secara teknis arsitektur sistem, sumber aliran data (data flow), pemrosesan logika, serta peta relasi antar-file di dalam sistem `crypto-bot-wallet-follower`.

---

## 1. Diagram Arsitektur & Alur Data Tingkat Tinggi

```
                  ┌─────────────────────────────────────────────────────────┐
                  │                 SUMBER DATA EKSTERNAL                   │
                  ├────────────────────────────┬────────────────────────────┤
                  │ GMGN WebSocket Stream      │ Solana RPC WebSocket       │
                  │ (ws.gmgn.ai via Chrome CDP)│ (logsSubscribe dev wallet) │
                  └─────────────┬──────────────┴─────────────┬──────────────┘
                                │                            │
                                ▼                            ▼
┌────────────────────────────────────────────────────────────────────────────────────────┐
│ WORKER INGESTION: scripts/run-wallet-follower.ts                                       │
│  - CDP Session (Port 9223) mendengarkan Network.webSocketFrameReceived                  │
│  - Dispatch channel: wallet_activity_info, token_activity, token_stat, major_coin_price │
│  - SingleDevWalletWatcher: deteksi deployment dev pool baru                            │
└───────────────────────────────────────┬────────────────────────────────────────────────┘
                                        │
                                        ▼ (WalletTradeSignal & PriceTicks)
┌────────────────────────────────────────────────────────────────────────────────────────┐
│ ENGINE EVALUASI SKENARIO: src/multi-scenario-dryrun-engine.ts                          │
│  - Filter Ground Zero & Anti Mid-Flight (isFirstBuy / targetBalanceBefore = 0)         │
│  - Filter Strict 1-Mint-1-Buy per Lane (closedTrades.some(t => t.mint === mint))      │
│  - Filter Anti-Pucuk ($0.000020) & Bundler Rate (>= 5.0%)                             │
│  - Grace Period 60s (AP2/AP3) & Whale Hoarding Trap Defense (AP3)                      │
│  - Evaluasi S4 - S15, S13 Centaur, serta AP1-3 & AP1-3 Net 10%                         │
└──────────────────────┬──────────────────────────────────────────┬──────────────────────┘
                       │ (BUY Ticket / Sinyal Entry)              │ (SELL Intent / TP Signal)
                       ▼                                          ▼
┌──────────────────────────────────────────────┐ ┌───────────────────────────────────────┐
│ AKUNTANSI & QUOTE BUY:                       │ │ EXIT MONITOR & QUOTE SELL:            │
│ src/ap-paper-accounting.ts                   │ │ src/ap-exit-monitor.ts                │
│  - reserveApBuy() potong kas + fee ($0.025)  │ │  - Polling kuotasi AMM tiap 1s        │
│  - syncRealBuyExecution() isi token riil     │ │  - Instant trigger via event Whale    │
└──────────────────────┬───────────────────────┘ └───────────────────┬───────────────────┘
                       │                                             │
                       └──────────────────────┬──────────────────────┘
                                              ▼
┌────────────────────────────────────────────────────────────────────────────────────────┐
│ EKSEKUSI KUOTASI AMM RIIL (BROWSER ROUTING):                                           │
│ src/browser-swap-route.ts & src/ap-paper-execution.ts                                  │
│  - Query `/txproxy/v1/get_swap_route` via GMGN internal page context                   │
│  - Hit AMM pool on-chain langsung (PumpAMM, Raydium, Meteora) via pairAddress          │
│  - Eksekusi 2x Probe (Probe 1 baseline, Probe 2 jeda 300ms untuk ukur slippage riil)   │
│  - Simpan audit kuotasi lengkap ke data/ap-paper-quotes.jsonl                          │
└───────────────────────────────────────┬────────────────────────────────────────────────┘
                                        │ (State update & PnL sinkron)
                                        ▼
┌────────────────────────────────────────────────────────────────────────────────────────┐
│ STATE PERSISTENCE & DASHBOARD:                                                         │
│  - data/dryrun-3scenarios-live.json (State portofolio, open positions, closed trades)  │
│  - scripts/serve-wallet-follower-dashboard.mjs (API Server Port 4192)                  │
│  - scripts/render-3scenarios-live.mjs (UI Web live di /add-fol/3scenarios)             │
└────────────────────────────────────────────────────────────────────────────────────────┘
```

---

## 2. Rincian Sumber Data (Data Ingestion)

Sistem menggunakan 3 jalur penerimaan data real-time:

### A. GMGN WebSocket Stream (`ws.gmgn.ai`)
Dihubungkan melalui **Chrome DevTools Protocol (CDP)** pada `http://127.0.0.1:9223` menggunakan session `Network.enable`. Setiap frame WebSocket ditangkap lewat event `Network.webSocketFrameReceived`:

| Channel | Format Payload | Fungsi dalam Sistem |
| :--- | :--- | :--- |
| `wallet_activity_info` | `{ a: mint, e: 'buy'/'sell', ba: tokenAmount, b: remaining, qa: solAmount, au: usdAmount, pu: price, ooc: 1, hba: prevBalance, h: txHash }` | Mendeteksi transaksi beli/jual dari Target Whale (`3azG8rmt...`) secara instan sub-detik. |
| `token_activity` | `{ a: mint, e: 'buy'/'sell', p: price, qa: solAmount }` | Merekam aktivitas order retail dan sniper di pool token yang sedang aktif dipantau. |
| `token_stat` | `{ a: mint, p: spotPrice }` | Streaming harga sub-detik untuk pembaruan floating PnL dan trigger trailing stop. |
| `major_coin_price` | `[{ symbol: 'SOL', price: 80.65 }]` | Sinkronisasi harga konversi SOL/USD real-time untuk kalkulasi nominal stake dan fee. |

### B. Solana RPC WebSocket (`logsSubscribe`)
Diatur oleh `SingleDevWalletWatcher` di dalam `scripts/run-wallet-follower.ts`:
- Memantau wallet developer (`HbxZJx99...`) langsung ke node RPC Solana.
- Mendeteksi transaksi pembuatan pool baru (Genesis Block) sebelum target whale melakukan pembelian pertama.
- Mendeteksi instruksi `Withdraw` / `RemoveLiquidity` untuk pemicu *emergency panic sell*.

### C. GMGN Internal Route Proxy (`/txproxy/v1/get_swap_route`)
Dipanggil secara headless melalui `page.evaluate()` di browser page token:
- Memberikan kuotasi rute swap AMM aktual untuk pair SOL $\leftrightarrow$ Token.
- Mengembalikan data `inAmount`, `outAmount`, `priceImpact`, dan rute pool (`pair_address`).

---

## 3. Tahapan Pengolahan Data (Processing Pipeline)

```
[Frame Diterima] ──> [Filter Validitas & Anti-Duplikasi] ──> [Analisis Signal] ──> [Safety Gates] ──> [Eksekusi Rute AMM]
```

### Langkah 1: Deduplikasi & Normalisasi Transaksi
1. Memeriksa `txHash` pada set `processedTxHashes` (kapasitas ring-buffer 2.000 transaksi). Transaksi duplikat langsung diabaikan.
2. Menentukan apakah aksi adalah `FIRST_BUY`:
   - `ooc === 1` (Open Position resmi GMGN), ATAU
   - `event_type === 'new_holder'`, ATAU
   - `hba === 0` dan `b === ba` (Saldo sebelum beli adalah 0).
3. Jika whale sudah memiliki sisa saldo (`b > 0` dan bukan first buy), order diklasifikasikan sebagai `BUY_MORE` atau `PARTIAL_SELL`.

### Langkah 2: Evaluasi Safety Gates & Gating
Signal diteruskan ke `MultiScenarioDryRunEngine`:
1. **Strict Ground Zero Gate**: Skenario menolak pembelian jika target sudah memegang token sebelumnya (*anti mid-flight*).
2. **Strict 1-Mint-1-Buy per Lane**: Memeriksa `scenario.closedTrades.some(t => t.mint === mint)` dan `scenario.openPositions.some(p => p.mint === mint)`. Jika mint sudah pernah ditradingkan, sistem mengeluarkan event `SKIP: REJECT_ALREADY_TRADED`.
3. **Bundler Rate Gate ($\ge 5.0\%$)**: Untuk AP1, AP2, dan AP3, sistem memeriksa kepemilikan Jito bundle genesis melalui `/api/v1/token_stat/sol/${mint}`. Jika di bawah 5.0%, token dianggap *bait rugpull* murah dan dilewati.
4. **Grace Period Gate (60 Detik)**: AP2 dan AP3 menahan eksekusi hingga umur token mencapai $\ge 60$ detik untuk menghindari rugpull detik awal.
5. **Whale Hoarding Trap Defense**: Khusus AP3, jika kepemilikan whale bertambah $\ge +25\%$ dari baseline atau total bag melebihi 8.0% supply (>80M token) akibat menelan ordernya sendiri, posisi langsung ditutup 100% (*Emergency Exit*).

### Langkah 3: Eksekusi Double-Probe AMM Paper
Untuk skenario AP:
1. **Cadangan Kas (Reserve)**: `reserveApBuy()` memotong saldo kas sebesar nominal stake (misal $5.00) ditambah fee paper $0.025. Posisi dibuat dengan status `BUY_PENDING`.
2. **Probe 1**: Mengambil rute AMM langsung untuk baseline likuiditas.
3. **Probe 2 (Delay 300ms)**: Mengambil kembali rute AMM untuk mengukur slippage nyata setelah slot berjalan.
4. **Sinkronisasi**: Token aktual yang diterima dari quote dicatat ke dalam objek `ScenarioPosition`.

### Langkah 4: Pemantauan Exit (Exit Monitoring)
1. **Periodic Poll (1 Detik)**: `ApExitMonitor.tick()` memeriksa seluruh posisi terbuka, meminta executable sell quote token $\to$ SOL untuk seluruh saldo `baseUnits`.
2. **Evaluasi Target**:
   - Untuk **AP Net 10%**: Menghitung `gross = (outAmount / 1e9) * solPriceUsd`. Jika `(gross - 0.050) / invested >= 10.0%`, langsung eksekusi `NET_TP_10%_FULL`.
   - Untuk **AP Standar**: Target Take Profit bertahap (+50% jual 50%, sisa moonbag ke +100%) atau trailing stop.
3. **Event-Driven Whale Sell Exit**: Jika WebSocket mendeteksi whale menjual $\ge 3$ kali berturut-turut signifikan ($\ge 3$ SOL) atau dump besar $\ge 15$ SOL, monitor langsung mengeksekusi liquidation tanpa menunggu timer 1 detik.

---

## 4. Peta Hubungan Antar-File (Dependency Map)

| Path File | Kategori | Peran & Tanggung Jawab Utama | Bergantung Pada |
| :--- | :--- | :--- | :--- |
| `scripts/run-wallet-follower.ts` | **Runner / Worker** | Service utama daemon follower. Menghubungkan CDP Chrome, mendengarkan WebSocket GMGN & Solana RPC, mengatur heartbeat, dan mendelegasikan aksi. | `MultiScenarioDryRunEngine`, `ApExitMonitor`, `browser-swap-route.ts`, `follower-live-store.ts` |
| `src/multi-scenario-dryrun-engine.ts` | **Core Engine** | Menyimpan seluruh state 6 varian skenario (AP1–3, AP1–3 Net10, S4–S15). Mengelola cash balance, entry evaluation, safety guards, dan event log. | `ap-lanes.ts`, `ap-paper-accounting.ts`, `follower-live-store.ts`, `autobuy-scenario-guard.ts` |
| `src/ap-lanes.ts` | **Registry & Config** | Deklarasi resmi metadata lane: key, id skenario, label, parentKey, dan flag `net10: boolean`. | `multi-scenario-dryrun-engine.ts` |
| `src/ap-exit-monitor.ts` | **Monitoring** | Worker background interval 1s untuk meminta executable quote jual dan mengevaluasi ambang batas Net TP / Stop Loss. | `ap-paper-accounting.ts`, `ap-paper-execution.ts`, `multi-scenario-dryrun-engine.ts` |
| `src/ap-paper-accounting.ts` | **Akuntansi** | Penghitungan matematis pemotongan kas, reservasi tiket, validasi kecocokan tiket, dan pemotongan flat fee gas ($0.025 / $0.050). | `multi-scenario-dryrun-engine.ts` |
| `src/ap-paper-execution.ts` | **Eksekusi Helper** | Wrapper timeout dan validasi struktur data rute AMM (`boundedApQuote`, `validApRoute`). | `browser-swap-route.ts` |
| `src/browser-swap-route.ts` | **AMM Router** | Memanggil endpoint rute swap internal GMGN (`/txproxy/v1/get_swap_route`) langsung dari tab browser yang aktif. | Playwright `Page` |
| `src/autobuy-scenario-guard.ts` | **Safety Guard** | Guard autorisasi order live. Memastikan lane Net10 terkunci immutable `false` (paper-only) dan memvalidasi setting modal. | `ap-lanes.ts` |
| `src/follower-live-store.ts` | **Konfigurasi I/O** | Membaca dan menulis file konfigurasi runtime `data/follower-autobuy-settings.json` secara atomik dengan safe fallbacks. | File system (`node:fs`) |
| `scripts/serve-wallet-follower-dashboard.mjs` | **Web Server** | HTTP Server di port 4192. Menyediakan API konfigurasi (`/api/autobuy/config`), timeline JSON, dan static dashboard. | `render-3scenarios-live.mjs`, `follower-live-store.ts` |
| `scripts/render-3scenarios-live.mjs` | **UI Renderer** | Menghasilkan kode HTML/CSS/JS dashboard live `/add-fol/3scenarios` dengan panel kontrol stake dan audit transaksi. | Data state JSON |
