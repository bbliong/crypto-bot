# Arsitektur GMGN Trend 20m Lane, Filter Injection, dan WebSocket Quota Partitioning

Dokumen ini menjelaskan implementasi teknis untuk integrasi tab baru **GMGN Trend**, pemisahan kuota WebSocket GMGN menjadi 3 pool (masing-masing 10 token), serta strategi trading paper **Trend 20m Lane** yang menahan token ("let winners run") selama metrik holder bertambah, dengan trailing stop di atas 60% dan batas waktu watching maksimal 2 jam.

---

## 1. Konfigurasi Filter Tab GMGN Trend

### URL Target
- **URL**: `https://gmgn.ai/trend?chain=sol&ref=bFC8902n`
- **File Konfigurasi**: `config/trend-filter-settings.json`

### Pemetaan Injeksi LocalStorage (`filter_query_map`)
GMGN menyimpan status filter UI pada `localStorage.getItem("filter_query_map")` dengan prefix filter `9`:

| Kunci GMGN | Nilai Riil Target | Nilai Dummy Uji | Keterangan |
|---|---|---|---|
| `9mic` | `"20"` | `"2924"` | Usia minimal koin (20 menit) |
| `9minhhm` | `"10000"` | `"2925000"` | All-Time High Market Cap minimal ($10k) |
| `9mihc` | `"100"` | `"2923"` | Jumlah pemegang (holder) minimal 100 |
| `9ihc` | `"1"` | `"1"` | Toggle aktif filter holder (`1` = ON) |

Injeksi diaplikasikan pada scope path `/trend2_sol`, `trend2_sol`, `/trend_sol`, dan `trend_sol` melalui `page.addInitScript()` sebelum dokumen dimuat dan divalidasi ulang via `page.evaluate()` setelah commit.

---

## 2. Partisi Kuota WebSocket GMGN (Total 30 Token, Dibagi 3 Pool)

Sebelumnya, watching WebSocket GMGN menggunakan batas VIP dan Reguler tanpa kuota terisolasi antar worker. Sistem kini membagi kuota menjadi 3 pool strictly terisolasi di `src/gmgn-token-websocket.ts`:

1. **Pool Momentum** (`momentum`): Maksimal 10 token.
2. **Pool Smart Money** (`smartmoney`): Maksimal 10 token.
3. **Pool Trend 20m** (`trend20m`): Maksimal 10 token.
- **Total Kuota Watching**: 30 token secara simultan.

### Mekanisme Proteksi & Eviksi
- **FIFO per Pool**: Jika salah satu pool (misal `trend20m`) menerima token ke-11, hanya token terlama di dalam pool tersebut yang di-unsubscribe dan digantikan. Token di pool `momentum` dan `smartmoney` tidak akan terpengaruh.
- **Auto-Sweep Expiry (Max 2 Jam)**: Setiap kali token didaftarkan atau melalui siklus `sweepExpired()`, token yang usia watching-nya melebihi batas waktu (default 7.200 detik / 2 jam) akan otomatis di-unsubscribe dari browser WebSocket GMGN untuk menjaga efisiensi RAM dan bandwidth.

---

## 3. Logika Strategi Paper Trading Trend 20m Lane (`DistributionTrend20mLane`)

- **File**: `src/distribution-trend-20m-lane.ts`
- **Tujuan Utama**: Mengamankan profit minimal **+20%**, dengan potensi multi-bagger hingga **60%+** jika pertumbuhan holder terus meningkat.

### Aturan Entry (Filter Gerbang)
1. Usia koin terverifikasi minimal 20 menit (`transferAge >= 1200` detik).
2. Jumlah holder koin minimal 100 (`holderCount >= 100`).
3. Tidak terdeteksi risiko pelarian holder / dev dump (`holderGrowth15s >= -3` dan `!holderDeclineEverSeen`).
4. Buy share sehat (`buyShareUsdPercent >= 55%`) dengan minimal 2 buyer independen.

### Aturan Exit & Penguncian Profit
1. **Hard Stop Loss (-10%)**:
   - Jika harga drop ke `<= -10.0%`, trigger `STOP_LOSS_10PCT`.
2. **Fase Target +20% s/d +59.9% (Runner dengan Syarat Holder)**:
   - Jika profit menyentuh `>= +20.0%`:
     - **Jika Holder Bertambah/Stabil** (`holderGrowth15s >= 0`): Posisi **tetap ditahan** (`return null`, let winners run).
     - **Profit Floor Lock (+15%)**: Jika harga sempat `>= +20%` lalu pullback turun ke `<= +15%`, sistem langsung mengeksekusi `PROFIT_FLOOR_SECURED_15` untuk mengamankan cuan dan mencegah berbalik rugi.
     - **Jika Holder Mulai Berkurang / Dump** (`holderGrowth15s < 0` atau terdeteksi outflow): Segera eksekusi `HOLDER_DECLINING_TAKE_PROFIT_20`.
3. **Fase Super-Runner: Trailing Stop / Loss (> +60%)**:
   - Jika harga mencapai peak gross return `>= +60.0%`:
     - Trailing stop aktif dengan toleransi drawdown **6.0%** dari titik tertinggi (`peakGrossSeen`).
     - Jika terjadi pullback `>= 6.0%` dari peak, posisi ditutup dengan sinyal `TRAILING_PROFIT_ABOVE_60`.
4. **Batas Waktu Maksimal (Max Hold 2 Jam)**:
   - Jika posisi sudah terbuka selama 7.200 detik (2 jam) dan belum menyentuh TP/SL, sistem menutup posisi dengan alasan `MAX_HOLD_2H_TIMEOUT`.
5. **Stagnasi Volume (45 Menit)**:
   - Jika setelah 45 menit volume transaksi mati dan harga tidak bergerak, sistem menutup slot dengan `STAGNANT_NO_VOLUME_45M`.

---

## 4. Alur Integrasi Antar-Komponen

```
[ Playwright Chrome ]
    ├── Tab 1: GMGN New Pairs / Momentum (wss capture) -> FeedHub CANDIDATE (gmgn_research_ws)
    │                                                        │
    ├── Tab 2: GMGN Trend 20m Filter (wss capture) ----> FeedHub CANDIDATE (gmgn_trend_ws)
    │           (LocalStorage injected: 9mic=20,             │
    │            9minhhm=10k, 9mihc=100)                     ▼
    │                                                   [ FeedHub Server :8765 ]
    │                                                        │
    └── Dedicated GMGN Token WebSocket Manager               ├── worker-momentum (Pool: 10 slot)
          (Pool Momentum: 10 token)  <-----------------------├── worker-smartmoney (Pool: 10 slot)
          (Pool SmartMoney: 10 token)<-----------------------└── worker-trend20m (Pool: 10 slot)
          (Pool Trend 20m:  10 token)<------------------------------┘ (scripts/run-trend20m-worker.mjs)
```

---

## 5. Ringkasan File Terkait & Verifikasi

1. `config/trend-filter-settings.json`: File setelan URL dan query injection map GMGN Trend.
2. `src/gmgn-token-websocket.ts`: Modul manager WebSocket dengan kuota 3-pool terisolasi 10-10-10 dan auto-sweep timeout 2 jam.
3. `src/distribution-trend-20m-lane.ts`: Implementasi lane Trend 20m (target 20%, trailing 60%+, floor lock 15%, max hold 2 jam).
4. `src/distribution-profit4-runtime.ts`: Runtime router yang mendukung pipeline `gmgn_trend_ws` dan `trend20m`.
5. `src/distribution-watch-four-tabs.ts`: Integrasi pembukaan tab kedua di Playwright dengan injeksi filter localStorage.
6. `scripts/run-trend20m-worker.mjs`: Script runner worker terpisah untuk engine Trend 20m.
7. `tests/distribution-trend-20m-lane.test.ts`: 8 unit test aturan entry, hold, TP, floor lock, trailing stop 60%+, dan timeout (Status: PASS).
8. `tests/gmgn-token-websocket-quota.test.ts`: Unit test pemisahan kuota 10-10-10 dan auto-sweep 2 jam (Status: PASS).
9. `tests/distribution-profit4-trend20m-integration.test.ts`: Integration test runtime Trend 20m (Status: PASS).
