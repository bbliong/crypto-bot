# Kolektor riset holder dan aktivitas GMGN

Jalankan kolektor terpisah dengan `npm run research -- --detailSeconds 600 --workers 3`. Secara default proses berjalan tanpa batas waktu sampai dihentikan atau jendela Chrome kolektor ditutup. Gunakan `--seconds 1800` untuk membatasi run menjadi 30 menit; `--seconds 0` berarti tanpa batas. Maksimal 3 tab detail dipakai bersama 1 tab feed GMGN.
Ia menggunakan profil Chrome `profiles/research-aria-tele01`, membuka paling banyak tiga detail GMGN, dan tidak pernah membuka Fomo atau melakukan transaksi sungguhan. Setiap token detail mendapat posisi simulasi sebesar $0,25 saat harga detail pertama tersedia. Posisi simulasi dijual pada target +40%, trailing turun 10% setelah pernah +20%, stop -20%, tekanan jual, atau akhir observasi. Ketika socket mengirim pembaruan jumlah holder total, aturan holder dapat menahan posisi: penurunan −10% sampai −20% ditahan 10 detik bila holder bertambah minimal 10% dan 5 serta buy USD 5 detik tidak kalah dari sell USD. Target +40% ditunda bila ada dua pembaruan holder signifikan beruntun dan harga masih naik minimal 2% per 5 detik; target dijual saat momentum di bawah 0,5% per 5 detik. Tanpa pembaruan jumlah holder total dari socket, aturan holder berstatus tidak tersedia dan tidak memengaruhi exit.

Token hanya masuk antrean detail jika data feed WebSocket yang tersedia saat itu memenuhi: umur maksimal 900 detik tanpa umur minimum, holder minimal 8, likuiditas USD 6.000–15.000, dan Top-10 holder maksimal 30%. Saat slot detail kosong, token eligible terbaru dipilih lebih dulu; kandidat lama yang menunggu lebih dari 10 menit dibuang. Buy/sell tidak dipakai sebagai penolak di feed karena field tersebut belum stabil pada event awal; aktivitas detail direkam untuk dianalisis setelahnya.

Setiap run menulis folder `research/<run-id>/`.

- `screened-tokens.jsonl`: alasan faktual token dapat masuk detail dan snapshot field gate.
- `screening-rejected.jsonl`: token yang ditolak saat screening, dengan alasan per rule (`age`, `holders`, `liquidityUsd`, atau `top10Percent`).
- `screening-rejection-summary.json`: jumlah token yang ditolak dan frekuensi masing-masing alasan, diperbarui setiap penolakan.
- `screening-rejected-young.jsonl`: daftar khusus token umur 0–900 detik yang gagal rule selain umur; token tua tidak masuk file ini.
- `screening-young-rejection-summary.json`: ringkasan alasan penolakan khusus token muda.
- `trades.jsonl`: setiap buy/sell WebSocket, signature, waktu, harga, nominal, alamat trader jika tersedia, serta field publik mentah untuk memeriksa perubahan skema GMGN.
- `research.sqlite`: penyimpanan utama semua data holder. `holder_api_observations` menyimpan setiap respons endpoint GMGN; `holder_snapshots` dan `holder_balances` hanya menyimpan daftar holder penuh bila nilainya berubah. Data holder dari socket memakai tabel `socket_holder_observations`, `socket_holder_snapshots`, dan `socket_holder_balances` dengan prinsip yang sama. Database memakai WAL agar pembacaan laporan dan penulisan collector dapat berjalan bersamaan.
- `monitor-comparison.jsonl`: perbandingan tiap 5 detik: saldo holder yang teramati, perubahan saldo dari snapshot awal, top holder teramati, serta buy/sell 60 detik terakhir.
- `token-summary.jsonl`: satu ringkasan setelah observasi detail selesai, berisi waktu beli/jual per alamat yang tertangkap dan kaitannya dengan holder snapshot terbaru.
- `events.jsonl`: mulai detail, galat, dan `STOP_LOSS_REACHED` bila harga jatuh minimal 20% dari harga pertama setelah detail dibuka.
- `simulated-trades.jsonl`: pembelian dan penjualan simulasi, alasan exit, harga, kuantitas, P/L kotor, serta data keputusan socket yang memicu sell.
- `simulation-summary.json`: jumlah posisi simulasi, total modal, total untung/rugi, jumlah untung/rugi, serta alasan exit. Simulasi memakai fee dan slippage nol; ini bukan hasil order yang dapat dieksekusi.
- `manifest.json`: parameter dan rule run.

Kolom `estimatedOwnershipPercent` pada ringkasan adalah perkiraan `balance / (marketCapUsd / priceUsd)`. Ini hanya dipakai sebagai bahan audit, bukan fakta kepemilikan; analisis akhir harus memvalidasi arti field holder dari payload mentah.
