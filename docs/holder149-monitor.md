# Holder149: worker Playwright dan dashboard terpisah

Daftar tetap `config/holder149-wallets.json` berasal dari 149 kandidat historis
September–Oktober: holder terlihat pada >=5 mint berbeda dan semua setup paper
terkait positif. Ini asosiasi dengan hasil paper bot, bukan PnL pribadi holder.
Worker lama, daftar enam wallet, profil, dashboard, dan datanya tidak diubah.

Untuk Ubuntu/Debian dan service systemd, lihat [panduan server](deploy-holder149-server.md).

## Menjalankan

```powershell
npm run wallet:holder149-profile
npm run dashboard:holder149-monitor
```

Buka http://127.0.0.1:4176 dan klik **Mulai worker**. CLI langsung:

```powershell
npm run wallet:holder149-watch
```

Profil baru `profiles/holder149-watch/Profile 12` disalin sekali dari profil
login `profiles/buy-sell-watch/Profile 12`, bersama Local State; tidak mencetak
atau mendekripsi cookie. Salinan hanya boleh dilakukan ketika profil sumber
dan tujuan tidak dipakai Chrome. Salinan lama tidak ditimpa; profil tujuan
yang belum lengkap dibackup sebelum diganti. Login hasil salinan tetap perlu
diverifikasi di GMGN; jika kadaluarsa, login di jendela Chrome worker baru.

## Jadwal dan batas

- Tiga GET aktivitas **paralel** lewat `page.evaluate(fetch(...))` dalam satu
  tab controller yang memiliki sesi Chrome. Ini tetap request API GMGN.
- Batch dimulai paling cepat setiap 3000ms. Tunggu batch sebelumnya selesai;
  tidak ada batch tumpang tindih. API lambat dapat memperpanjang jadwal.
- Urutan round-robin seluruh 149 wallet; batch terakhir berisi dua wallet.
  50 batch = sekitar 150 detik per putaran, bukan 149 wallet setiap 3 detik.
- HTTP 429 memicu backoff global 15, 30, lalu maksimal 60 detik.
- Maksimal tiga **mint unik**, termasuk tab yang masih membuka/menutup.
  Total maksimal empat tab: satu controller + tiga detail. Pemindaian lanjut
  saat penuh; Buy baru dilewati tanpa antrean dan tidak dibuka belakangan
  sebagai Buy lama. Kalau muncul Buy yang lebih baru, boleh dicoba lagi.
- Hanya baris pertama feed newest-first **tanpa filter tipe** dapat membuka
  detail, dan harus Buy. Jika Sell/transfer di atas, tidak mencari Buy lama.
  Saat awal worker, Buy teratas yang sudah lama masih bisa terpilih seperti
  worker sebelumnya; tidak ada klaim deteksi transaksi baru saja.
- Tab aktif dipertahankan sampai Sell/manual close; Buy mint lain tidak
  mengganti tab aktif. Wallet dapat dipantau pada lebih dari satu mint selama
  kapasitas masih tersedia. Beberapa wallet pada mint sama berbagi satu tab.
- Sell pada mint yang sama oleh wallet terkait mengakhiri pantauan wallet
  tersebut, termasuk partial Sell. Trader lain tidak menutup detail. Tab
  berbagi ditutup ketika semua wallet terkait sudah Sell.
- Socket mendeteksi Sell segera saat paket diterima; polling aktivitas juga
  memeriksa Sell sebagai fallback pada giliran wallet berikut (~150 detik).
- Tidak ada swap quote, SOL price lookup, simulasi, atau transaksi nyata.

## Penyimpanan

Hanya **frame socket diterima dari detail yang berhasil dibuka** yang menjadi
log capture append-only. Frame saat navigasi dibuffer dan baru ditulis setelah
navigasi berhasil; gagal buka tidak membuat log socket. Paket Sell disimpan
sebelum detail ditutup. Tidak merekam socket controller atau query sesi pada
URL socket; metadata frame memuat mint, detail ID, dan wallet yang dipantau.

```text
data/holder149-watch/
  worker-control.json       # snapshot status kecil, bukan arsip respons API
  worker.log                # startup/error saja, bukan body aktivitas
  <run>/
    manifest.json           # konfigurasi run
    chunks/<UTC-30-min>/websocket-frames.jsonl
```

Tidak ada `api-responses.jsonl`, `buys.jsonl`, `sells.jsonl`, `token-trades.jsonl`,
atau `watch-events.jsonl`. Respons aktivitas hanya berada di memori selama
pemrosesan. Snapshot status menyimpan detail aktif, metrik, dan lifecycle ringkas
terbatas; bukan semua aktivitas. Partisi 30 menit tidak mengurangi total ukuran.
Dedup Buy ada di memori; restart meresetnya dan dapat mengamati ulang Buy teratas.

Tombol Stop meminta shutdown graceful lalu fallback penghentian proses milik
worker baru yang identitas command line-nya diverifikasi. Worker lain tidak
disentuh. HTTP dashboard hanya listen localhost, bukan untuk publik.
