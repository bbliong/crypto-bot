# Flow Browser Buy & Automated Trading (`browser:buy:auto` & `browser:buy`)

Pipeline ini mengintegrasikan eksekusi order GMGN langsung dari konteks tab browser aktif dengan collector riset Momentum V2.

## Mode Eksekusi

### 1. Mode Otomatis Tanpa Modal (`browser:buy:auto`)
Menjalankan pipeline riset secara kontinu (`--seconds 0`, `--workers 3`, `--stakeUsd 0.25`) dan mengeksekusi order Buy & Sell secara langsung via API GMGN (`/mrtapi/v2/swap_batch_order`) di dalam sesi browser aktif tanpa menampilkan modal prompt konfirmasi.

```bash
# Menjalankan di VPS (Linux / Headless Xvfb)
DISPLAY=:99 npm run browser:buy:auto -- --profileDir profiles/research-vps --profileName Default

# Atau di Windows / Local
npm run browser:buy:auto
```

Argumen internal yang diaktifkan secara otomatis:
- `--strategy momentum-v2`: Menggunakan strategi momentum V2 penuh.
- `--browserAutoTrade`: Melewati modal konfirmasi browser dan langsung mengirim swap batch order.
- `--orderOutcomeCapture`: Menangkap seluruh respons API GMGN (termasuk `/smartmoney/sol/walletstat/`) setelah order.
- `--controlOnly`: Menonaktifkan perbandingan dual-lane (R5-band), memfokuskan report pada satu lane kontrol dengan komparasi data simulasi vs riil.

### 2. Mode Konfirmasi Manual (`browser:buy` / `browser:buy:test`)
Menampilkan modal prompt konfirmasi di layar sebelum order Buy dan Sell dikirim ke API GMGN:

```bash
npm run browser:buy
```

## Alur Eksekusi Otomatis (`browser:buy:auto`)

1. **Screening & Monitoring**: Worker memantau kandidat token dari feed GMGN socket secara realtime.
2. **Evaluasi Sinyal Momentum V2**: Sinyal Buy dinilai berdasarkan kriteria lengkap (candle history, flow, holder distribution, blind protection, momentum 5s).
3. **Route & Submit Buy**:
   - Tab meminta quote fresh melalui `GET /txproxy/v1/get_swap_route`.
   - Melewati modal konfirmasi (`skipPrompt = true`).
   - Melakukan refresh route seketika sebelum submit.
   - Mengirim `POST /mrtapi/v2/swap_batch_order` dengan header `authorization` dan `from_address` sesi browser aktif.
   - Mencatat hasil submit ke `events.jsonl` dan `live-trade-ledger.jsonl`.
4. **Capture Walletstat**:
   - Setelah order Buy terkonfirmasi, sistem meminta snapshot `/smartmoney/sol/walletstat/{wallet}` untuk mencatat volume perolehan token riil, harga rata-rata beli riil (`history_avg_cost`), dan biaya riil (`history_bought_cost`).
5. **Evaluasi Exit & Submit Sell**:
   - Setelah Buy terisi, listener risiko mengamati tick WebSocket untuk trigger Sell Momentum V2 (hard stop, target profit, trailing stop, whale/dev dump).
   - Saat sinyal Sell tercapai, sistem langsung meminta swap route jual 100% dan mengirim `POST /mrtapi/v2/swap_batch_order` tanpa modal konfirmasi.
   - Mengambil kembali snapshot `/smartmoney/sol/walletstat/{wallet}` untuk mencatat hasil pendapatan jual (`history_sold_income`), harga jual riil (`avg_sold`), dan gross P/L nyata.
6. **Pelepasan Tab Multi-Worker**:
   - Tab otomatis diarahkan ke `about:blank` setelah selesai tanpa menunggu operator menutup tab manual, sehingga worker segera siap memproses kandidat berikutnya.

## Format Laporan Komparasi (Single-Lane 2 Datasets)

Laporan HTML (`simulation-report.html` & `dist/paper-simulation-report.html`) pada mode single-lane menampilkan tabel perbandingan langsung antara:

1. **Perhitungan Sinyal Simulasi (Paper)**:
   - Waktu sinyal Buy, nominal stake, harga entry sinyal, dan alasan lolos entry gate.
   - Waktu sinyal Sell, harga exit sinyal, dan alasan exit rule.
   - Nilai P/L sinyal simulasi ($ dan %).

2. **Data Riil API / Wallet GMGN**:
   - Waktu submit Buy riil, total biaya beli riil (`history_bought_cost`), volume unit token perolehan, harga rata-rata beli riil (`history_avg_cost`), serta link transaksi Solscan / Order ID.
   - Waktu submit Sell riil, total pendapatan jual riil (`history_sold_income`), harga jual riil (`avg_sold`), serta link transaksi Solscan / Order ID.
   - Gross P/L riil (`history_sold_income - history_bought_cost`), persentase P/L riil, dan sisa saldo token.

3. **Selisih Riil vs Simulasi**:
   - Selisih dolar P/L riil terhadap sinyal simulasi.
   - Persentase slippage harga beli riil terhadap harga sinyal awal (`Slip entry: ±X%`).

## Event Utama pada Log

| Event | Keterangan |
|---|---|
| `BROWSER_BUY_SUBMITTED` | Order Buy berhasil dikirim ke API GMGN dari tab browser. |
| `BROWSER_SELL_SUBMITTED` | Order Sell berhasil dikirim ke API GMGN dari tab browser. |
| `GMGN_WALLETSTAT_SNAPSHOT` | Snapshot data walletstat riil dari API GMGN tercatat di ledger. |
| `LIVE_ORDER_SUBMITTED` | Catatan transaksi riil dengan hash / orderId tersimpan di `live-trade-ledger.jsonl`. |
| `BROWSER_AUTH_REFRESHING` | Token auth kedaluwarsa; tab dimuat ulang untuk mengambil bearer token baru secara otomatis. |
