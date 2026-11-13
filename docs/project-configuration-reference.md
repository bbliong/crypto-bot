# Panduan Referensi Lengkap Konfigurasi, Skenario & Operasional Project (Crypto Bot)

Dokumen ini merupakan panduan tunggal terlengkap (*single source of truth*) yang memuat seluruh informasi teknis, konfigurasi runtime, spesifikasi tiap skenario trading, struktur berkas data/state, layanan sistem, serta prosedur operasional pada sistem `crypto-bot`.

---

## 1. Ikhtisar Lingkungan & Identitas Sistem

- **Direktori Proyek:** `/home/bbliong/project/crypto-bot`
- **Node.js Runtime:** Node.js v22 (`/home/bbliong/.local/bin/node`)
- **Python Virtualenv:** `/home/bbliong/pqvenv`
- **Target Wallet yang Diikuti (Whale):** `3azG8rmtPnNUz77a6UqBKt1ykpk3JQpLLNTaoXW31b34`
- **Developer Radar Wallet:** `HbxZJx99...` (Solana WebSocket RPC watcher)
- **Koneksi Headless Browser:** Chrome via CDP di `http://127.0.0.1:9223`
- **Dashboard Internal:** `http://127.0.0.1:4192/add-fol/3scenarios`
- **Dashboard Public (Caddy Proxy):** `https://cr.bbliong.io/add-fol/3scenarios/sce4` (Port 4192)

---

## 2. Spesifikasi Lengkap Skenario & Trading Lanes

Sistem membagi strategi trading ke dalam dua kelompok utama: **AP Standar** (multi-stage TP & trailing) dan **AP Net 10%** (target pasti likuidasi 100% saat net gain mencapai +10%).

```
                  ┌───────────────────────────────────────────────┐
                  │          STRATEGI UTAMA TRADING BOT           │
                  ├───────────────────────┬───────────────────────┤
                  │     AP STANDAR        │      AP NET 10%       │
                  │ (Modal $5, TP Multi)  │ (Modal $5, TP Net 10%)│
                  └───────────┬───────────┴───────────┬───────────┘
                              │                       │
      ┌───────────────────────┼───────────────┐       │
      ▼                       ▼               ▼       ▼
┌──────────────┐      ┌──────────────┐┌──────────────┐┌──────────────┐
│     AP1      │      │     AP2      ││     AP3      ││ AP1/2/3-10%  │
│(Bundler Run) │      │(Grace >= 60s)││(Hoarding Def)││(Paper Only)  │
└──────────────┘      └──────────────┘└──────────────┘└──────────────┘
```

### A. Skenario AP Standar

| Lane Key | Nama Skenario | Saldo Awal | Modal per Entry | Syarat Masuk (Entry Rules) | Strategi Keluar (Exit Rules) |
| :--- | :--- | :--- | :--- | :--- | :--- |
| `s14` | **AP1: Bundler-Confirmed Runner (Wave Rider)** | $5.00 | $5.00 | 1. Bundler Rate $\ge 5.0\%$<br>2. Whale aktif ($\ge 1$ buyback)<br>3. Whale masih simpan $\ge 40\%$ bag | - TP Tahap 1: Jual 50% di $+50\%$ gain<br>- TP Tahap 2: Tahan sisa ke $+100\%$ / Whale Dump<br>- SL: $-20\%$ dari harga entry<br>- Exit: Whale sell $\ge 3$x beruntun ($\ge 3$ SOL) atau dump $\ge 15$ SOL |
| `s14_alpha` | **AP2: Bundler + 60s Grace Period** | $5.00 | $5.00 | 1. Umur token $\ge 60$ detik (kebal rugpull detik awal)<br>2. Bundler Rate $\ge 5.0\%$<br>3. Whale aktif | - TP Tahap 1: Jual 50% di $+50\%$ gain<br>- TP Tahap 2: Sisa ke $+100\%$ / Whale Dump<br>- SL: $-20\%$ dari harga entry<br>- Exit: Whale sell $\ge 3$x beruntun ($\ge 3$ SOL) |
| `s14_beta` (S15) | **AP3: Bundler + 60s Grace + Whale Hoarding Trap Defense** | $5.00 | $5.00 | 1. Umur token $\ge 60$ detik<br>2. Bundler Rate $\ge 5.0\%$<br>3. Saldo awal whale $15\text{M} \le \text{bag} \le 80\text{M}$ | - Sama seperti AP2, PLUS:<br>- **Hoarding Trap Defense:** Jika bag whale membengkak $\ge +25\%$ dari baseline atau $> 8.0\%$ supply (>80M) akibat menelan barang sendiri $\to$ **Langsung Full Exit 100% Seketika** |

### B. Skenario AP Net 10% (Paper-Only)

| Lane Key | Nama Skenario | Saldo Awal | Modal per Entry | Syarat Masuk | Logika Keluar Khusus (Net TP +10%) |
| :--- | :--- | :--- | :--- | :--- | :--- |
| `s14_net10` | **AP1-10%** | $20.00 | $5.00 | Mewarisi seluruh aturan masuk AP1 | Likuidasi penuh 100% posisi HANYA jika hasil bersih swap AMM: `(grossReturn - $0.050) / cashOutlay >= 10.0%`. |
| `s14_alpha_net10`| **AP2-10%** | $20.00 | $5.00 | Mewarisi seluruh aturan masuk AP2 (Grace 60s) | Sama (Full Net TP 10% setelah dikurangi flat fee gas $0.050). |
| `s14_beta_net10` | **AP3-10%** | $20.00 | $5.00 | Mewarisi seluruh aturan masuk AP3 (Grace + Hoarding) | Sama (Full Net TP 10%), serta tetap mempertahankan rem darurat Hoarding Trap Defense. |

*Catatan Keamanan:* Seluruh lane `*_net10` memiliki proteksi *hard-lock* `isNet10(scenarioId) === true` di `src/autobuy-scenario-guard.ts` sehingga **secara permanen ditolak dari transaksi live** meskipun setting Auto-Buy dinyalakan.

---

## 3. Rincian Konfigurasi Runtime (`data/follower-autobuy-settings.json`)

File ini mengontrol seluruh parameter modal, perizinan transaksi, dan batas toleransi eksekusi:

```json
{
  "enabled": false,
  "activeLane": "OFF",
  "autobuyScenario": "DRY_RUN",
  "stakeUsdLane1": 1.0,
  "stakeUsdLane2": 1.0,
  "stakeUsdS4": 1.0,
  "stakeUsdS5": 0.25,
  "stakeUsdS6Pool1": 1.0,
  "stakeUsdS6Pool2": 1.0,
  "stakeUsdS7Pool1": 1.0,
  "stakeUsdS7Pool2": 1.0,
  "stakeUsdS8": 1.0,
  "stakeUsdS9": 0.25,
  "stakeUsdS10": 1.0,
  "stakeUsdS13": 5.0,
  "stakeUsdS13Beta": 5.0,
  "stakeUsdS13Alpha": 5.0,
  "stakeUsdS13Beta1": 5.0,
  "stakeUsdS13Alpha1": 5.0,
  "stakeUsdS13Centaur": 5.0,
  "stakeUsdS14": 5.0,
  "stakeUsdS14Alpha": 5.0,
  "stakeUsdS14Beta": 5.0,
  "stakeUsdS15": 5.0,
  "stakeUsdAP1": 5.0,
  "stakeUsdAP2": 5.0,
  "stakeUsdAP3": 5.0,
  "stakeUsdAP1Net10": 5.0,
  "stakeUsdAP2Net10": 5.0,
  "stakeUsdAP3Net10": 5.0,
  "maxBuysQuota": 3,
  "maxActiveRealPositions": 1,
  "buySlippagePercent": 15,
  "sellSlippagePercent": 20,
  "priorityFeeSol": 0.0001,
  "tipFeeSol": 0.0001,
  "minSolReserve": 0.005,
  "autoSell": false,
  "reboundBuyEnabled": false,
  "maxCyclesPerToken": 1,
  "quotaResetAt": 1794236712872,
  "updatedAt": 1794537169570,
  "resetQuota": false
}
```

### Kamus Variabel Konfigurasi:
- `enabled` *(boolean)*: Saklar utama eksekusi swap riil on-chain. Wajib `false` saat mode evaluasi/paper.
- `autobuyScenario` *(string)*: Menentukan skenario mana yang berhak memesan order live (misal `'OFF'`, `'DRY_RUN'`, `'S14'`, `'S14_ALPHA'`).
- `stakeUsdAP1`, `stakeUsdAP2`, `stakeUsdAP3` *(number, $0.05–$1000)*: Modal entry per posisi untuk AP standar (default `$5.00`).
- `stakeUsdAP1Net10`, `stakeUsdAP2Net10`, `stakeUsdAP3Net10` *(number, $0.05–$1000)*: Modal entry independen untuk varian net 10% (default `$5.00`).
- `maxBuysQuota` *(number)*: Batas jumlah transaksi buy riil sebelum sistem otomatis menurunkan status menjadi `DRY_RUN`.
- `maxActiveRealPositions` *(number)*: Batas maksimal posisi terbuka riil on-chain secara bersamaan (default `1`).
- `buySlippagePercent` / `sellSlippagePercent` *(number)*: Toleransi slippage AMM (default 15% buy, 20% sell).
- `minSolReserve` *(number)*: Saldo minimal SOL di wallet yang tidak boleh tersentuh untuk biaya sewa akun token (rent exemption).

---

## 4. Struktur Berkas State & Log Audit

Seluruh berkas data terletak di direktori `/home/bbliong/project/crypto-bot/data/`:

### A. State Portofolio Runtime (`data/dryrun-3scenarios-live.json`)
Menyimpan state live yang terus diperbarui setiap detik:
```json
{
  "s14": {
    "id": "SCENARIO_14_BUNDLER_RUNNER",
    "name": "AP1: Bundler-Confirmed Runner (Wave Rider)",
    "initialCash": 5.0,
    "availableCash": 52.09,
    "investedCash": 0.0,
    "totalFeesPaid": 0.525,
    "realizedPnl": 47.09,
    "wins": 11,
    "losses": 1,
    "totalTrades": 12,
    "openPositions": [],
    "closedTrades": [
      {
        "mint": "7Er4n85ev1jASuMX4PeoxehMEPdMwQdRmtprMqWAPEHM",
        "symbol": "KRESS",
        "openedAt": 1794493190166,
        "closedAt": 1794493287652,
        "totalInvestedUsd": 5.0,
        "totalReturnedUsd": 5.265,
        "totalFeesPaidUsd": 0.05,
        "realizedPnlUsd": 0.265,
        "roiPct": 5.3,
        "exitReason": "S14_WHALE_3_CONSECUTIVE_SELLS",
        "provenance": "PAPER_AMM_QUOTE"
      }
    ],
    "recentEvents": []
  }
}
```

### B. Audit Trail Kuotasi AMM (`data/ap-paper-quotes.jsonl`)
Merekam setiap panggilan API rute swap riil (baris JSONL) yang memverifikasi bahwa PnL berasal dari quote AMM nyata:
```json
{
  "type": "AP_MONITOR_QUOTE",
  "ticket": { "lane": "SCENARIO_14_BUNDLER_RUNNER_NET10", "side": "SELL", "tokens": 32017659 },
  "request": { "lane": "SCENARIO_14_BUNDLER_RUNNER_NET10", "stakeUsd": 0, "solUsd": 80.65 },
  "quote": { "inAmount": "32017659057", "outAmount": "54484704" },
  "selected": true
}
```

---

## 5. Layanan Sistem (Systemd Services)

Sistem dijalankan di background sebagai daemon user systemd:

| Nama Layanan Unit | Peran Layanan | Perintah Manajemen |
| :--- | :--- | :--- |
| `crypto-bot-wallet-follower.service` | Worker utama: CDP browser, listener WebSocket, kalkulator evaluasi skenario, dan AMM quote runner. | `systemctl --user restart crypto-bot-wallet-follower`<br>`systemctl --user status crypto-bot-wallet-follower` |
| `crypto-bot-follower-dashboard.service` | Web server antarmuka port 4192: menyajikan UI pemantauan dan API perubahan modal. | `systemctl --user restart crypto-bot-follower-dashboard`<br>`systemctl --user status crypto-bot-follower-dashboard` |

### Perintah Cek Log Realtime:
```bash
journalctl --user -u crypto-bot-wallet-follower.service -f
```

---

## 6. Antarmuka Web Dashboard & REST API Endpoints

Server lokal berjalan pada port `4192`.

### A. Rute Halaman Web
- `GET http://127.0.0.1:4192/add-fol/3scenarios` : Menampilkan seluruh kartu skenario aktif, kontrol modal per lane, saldo portofolio, dan log transaksi terbuka/tertutup.

### B. REST API Pengaturan Modal & Auto-Buy
- **Endpoint:** `POST /api/autobuy/config`
- **Headers:** `Content-Type: application/json`
- **Contoh Request Body (Ubah Modal AP1 ke $5.00):**
  ```json
  {
    "stakeUsdS14": 5.0,
    "stakeUsdAP1": 5.0
  }
  ```
- **Contoh Request Body (Ubah Modal AP Net 10%):**
  ```json
  {
    "stakeUsdAP1Net10": 5.0,
    "stakeUsdAP2Net10": 5.0,
    "stakeUsdAP3Net10": 5.0
  }
  ```
- **Respon Sukses (HTTP 200):**
  ```json
  {
    "ok": true,
    "enabled": false,
    "config": { ... }
  }
  ```

---

## 7. Prosedur Operasional Standar (SOP)

1. **Memeriksa Status & Kesehatan Bot:**
   Jalankan pemeriksaan service:
   `systemctl --user is-active crypto-bot-wallet-follower.service crypto-bot-follower-dashboard.service`
2. **Mengubah Nilai Modal (Stake):**
   Gunakan form input pada dashboard `http://127.0.0.1:4192/add-fol/3scenarios` atau kirimkan payload POST ke `/api/autobuy/config`. Perubahan tersimpan secara atomik tanpa memerlukan restart service.
3. **Melakukan Backup State Sebelum Pembaruan Kode:**
   Cadangkan file state utama ke folder backup:
   `cp data/dryrun-3scenarios-live.json data/backups/dryrun-backup-$(date +%Y%m%d-%H%M%S).json`
4. **Verifikasi Integritas Pengujian (Regression Testing):**
   Sebelum melakukan commit git, jalankan verifikasi uji otomatis:
   `node --import tsx --test tests/ap-variants-net10.test.mjs tests/ap-dashboard-net10.test.mjs tests/test-autobuy-s14-s15-routing.mjs`
