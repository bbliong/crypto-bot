# Flow `browser:buy:test`

Perintah berikut menjalankan satu worker Momentum V2 pada profil Chrome GMGN yang telah dikonfigurasi.

```powershell
npm run browser:buy:test
```

Mode ini menggunakan stake `$0.25`, hanya lane kontrol V2, dan maksimal satu posisi paper. Request order tetap dibuat dari konteks tab GMGN melalui `fetch`, bukan dari HTTP client lokal.

## Sinyal test

Untuk mempercepat pengujian modal, mode ini tidak menunggu seluruh gate Momentum V2. Kandidat membuka alur Buy bila salah satu kondisi berikut terjadi:

- candle terakhir naik (`close > open`); atau
- dalam lima detik terdapat minimal tiga Buy socket dan jumlah Buy lebih besar daripada Sell.

Alasan sinyal dicatat sebagai `BROWSER_TEST_CANDLE_UP` atau `BROWSER_TEST_SOCKET_BUY_SURGE`. Aturan Momentum V2 dan simulasi biasa tidak berubah.

## Alur Buy

1. Worker membuka tab detail GMGN untuk kandidat.
2. Sistem meminta `GET /txproxy/v1/get_swap_route` dari tab tersebut.
3. Modal layar penuh menampilkan `SUBMIT BUY` dan `LEWATI`.
4. Setelah `SUBMIT BUY` diklik, sistem meminta route baru agar quote tidak kedaluwarsa.
5. Tab mengirim `POST /mrtapi/v2/swap_batch_order` dengan sesi GMGN aktif.
6. Respons berhasil dicatat sebagai `BROWSER_BUY_SUBMITTED`, termasuk `orderId` dan hash transaksi.

Tidak ada POST Buy sebelum tombol `SUBMIT BUY` diklik.

## Alur Sell

Evaluasi Sell baru dimulai setelah Buy berhasil. Ini mencegah sinyal Sell dari pergerakan harga sebelum Buy benar-benar dikirim.

1. Setelah respons Buy berhasil, event `BROWSER_SELL_ARMED` dicatat.
2. Tick socket berikutnya dinilai oleh aturan keluar Momentum V2.
3. Saat aturan keluar terpenuhi, modal `SUBMIT SELL` atau `LEWATI` tampil pada tab detail yang sama.
4. Setelah `SUBMIT SELL`, sistem meminta route Sell baru lalu mengirim `POST /mrtapi/v2/swap_batch_order` dari tab GMGN.
5. Respons berhasil dicatat sebagai `BROWSER_SELL_SUBMITTED`.

Sinyal Sell mencakup hard stop terkonfirmasi, major holder sell, profit lock, target 40%/50%, momentum fade, dan sell pressure. Lihat [momentum-v2.md](momentum-v2.md) untuk aturan strategi lengkap.

## Sesi dan token otorisasi

Header `authorization` ditangkap dari request yang dibuat frontend GMGN sendiri. Jika endpoint order mengembalikan `401` atau `403` dengan `token expired`, proses memuat ulang tab GMGN agar frontend membuat request dengan sesi baru. Modal order kemudian muncul kembali dan membutuhkan klik konfirmasi baru sebelum retry.

## Capture respons dan ledger

Setelah POST Buy atau Sell, respons XHR/fetch GMGN selama 60 detik direkam lokal pada:

```text
research/<run>/order-followup-responses.jsonl
```

Catatan order ringkas ditulis pada:

```text
research/<run>/live-trade-ledger.jsonl
```

Ledger berisi quote route Buy/Sell, nilai input dan output USD, price impact, platform/pool fee route, konfigurasi tip dan priority fee, serta snapshot `walletstat` setelah order.

Gross P/L dari respons `walletstat` dihitung sebagai:

```text
history_sold_income - history_bought_cost
```

Field `realized_profit` GMGN dapat mencakup riwayat transaksi token yang lebih lama pada wallet yang sama. Fee route adalah estimasi sebelum submit; fee jaringan final perlu dibaca dari transaksi Solana berdasarkan hash.

## Event utama

| Event | Arti |
|---|---|
| `BROWSER_BUY_PROMPT_OPENING` | Quote Buy tersedia dan modal akan ditampilkan. |
| `BROWSER_BUY_SUBMITTED` | GMGN menerima order Buy. |
| `BROWSER_SELL_ARMED` | Buy berhasil; aturan Sell mulai aktif. |
| `BROWSER_SELL_PROMPT_OPENING` | Quote Sell tersedia dan modal akan ditampilkan. |
| `BROWSER_SELL_SUBMITTED` | GMGN menerima order Sell. |
| `BROWSER_AUTH_REFRESHING` | Token sesi kedaluwarsa dan tab GMGN sedang dimuat ulang. |
