# Format baku report wallet follower

## Scope
Saat operator meminta report, tampilkan data aktual untuk skenario/periode yang diminta. Jika periode tidak disebut, nyatakan cakupan sesi yang masih tersimpan dan waktu snapshot WIB. Jangan mencampur arsip sebelum reset dengan sesi baru.

## Langkah verifikasi
1. Ambil snapshot read-only state dan hash sumber.
2. Hitung win/loss/BEP dari closed trades; pisahkan posisi open dan partial TP.
3. Cocokkan setiap closed trade dengan quote AMM BUY dan SELL sukses.
4. Cocokkan whale lewat mint + wallet + tx hash di raw feed, bukan simbol atau synthetic probe.
5. Atribusikan rugpull hanya jika ada transaksi drain/withdraw yang terhubung ke mint/pool. Jika belum ada bukti, isi UNKNOWN.
6. Simpan Markdown terpisah dari raw JSON, lalu periksa jumlah trade dan commit hanya kode/report.

## Isi wajib
- Waktu snapshot, periode, mode PAPER/REAL, status bukti PASS/PARTIAL/BLOCKED.
- Per skenario: jumlah win/loss/BEP full exit, posisi open, profit winner, loss loser, net closed PnL, partial realized/quote PnL terpisah, kas/modal tercatat.
- Per mint dan siklus: bot BUY/jumlah modal, whale BUY, partial TP/waktu/hasil, FULL EXIT/waktu/hasil/PnL USD dan %, alasan exit asli serta penjelasan.
- Whale SELL pertama, dump signifikan/besar beserta ukuran dan waktu. Jangan menyebut normal sell sebagai rugpull.
- Rugpull/drain: waktu, jenis kejadian, bukti tx/pool; UNKNOWN jika belum terverifikasi.
- Pisahkan hasil quote AMM dari spot unrealized dan uang nyata. Fee net mengikuti model engine, bukan biaya on-chain terukur.
- Nyatakan selisih accounting antara event BUY, modal quote, kas dan dashboard; jangan memaksa saldo agar cocok atau menutup posisi secara administratif.
- Partial TP tidak menambah jumlah win dan stage-1 proceeds tidak dijumlahkan lagi jika sudah termasuk totalReturned trade selesai.

## Tool S14-family
```bash
python3 scripts/report-follower-s14.py
```
Read-only terhadap worker/config/state dan tidak memanggil quote/trading baru. Menghasilkan `docs/reports/follower-s14-<stamp>.md` serta `data/reports/follower-s14-<stamp>/raw-evidence.json` dan `summary.json`.

Tool saat ini hanya mengambil sesi tersimpan S14/S14-Alpha/S15, bukan filter tanggal arbitrer. Untuk periode lain, lakukan ekstraksi berbatas khusus dan jelaskan retensi yang tersedia.
