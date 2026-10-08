# Protokol eksperimen same-entry exit, Codex v4

Dibekukan sebelum membaca hasil eksperimen ini, 3 Oktober 2026. Tidak mengubah implementasi AGY atau konfigurasi live.

## Pertanyaan dan universe

Apakah mengubah exit saja memberi nilai tambah bersih pada entry AGY yang identik? Gunakan seluruh sinyal AGY_NATIVE dari replay v3 sebagai cohort historis, bukan hanya posisi menang/selesai. Tidak membuat entry Codex baru atau menerapkan gate jam yang menghilangkan transaksi. Satu setup per detail dan satu percobaan per mint per 24 jam tetap sama.

Pembanding: AGY_NATIVE unchanged; AGY_REFERENCE (peak dan biaya net model); CODEX_DEFENSIVE; CODEX_TREND; CODEX_PULLBACK; CODEX_CONTEXT (memilih mode dari kondisi yang sudah diterima). Tepat empat hipotesis Codex, tidak ada sweep parameter.

## Aturan yang dibekukan

Semua exit Codex: hard net stop −6%, flash crash satu detik ≥8%, dev sell ≥$25/30s atau holder dump dengan harga melemah, dan gap harga >10s. Exit request tidak dianggap fill. Floor profit monoton dan hard stop tidak dilonggarkan saat ganti mode. Tidak ada averaging down.

- DEFENSIVE: floor aktif pada peak net +4% → +1%; trailing aktif +8%, jarak clamp(1,2×sigma,3%,5%). Konfirmasi flow reversal minimal dua tick/500ms; stagnasi12s; max hold45s.
- TREND: floor aktif +8% → +1,5%; trailing aktif +12%, jarak clamp(1,8×sigma,5%,8%). Flow reversal biasa dapat ditunggu maksimum2s hanya jika buy20≥65%, distribusi buyer baik, dan drawdown5≤4%; stagnasi20s; max hold90s.
- PULLBACK: floor/trailing sama dengan TREND; grace maksimum3s untuk pullback sehat, diukur sejak awal episode flow lemah, tidak direset oleh perubahan mode. Batas risiko/floor tetap berlaku; stagnasi20s; max hold90s.
- CONTEXT: TREND ketika histori≥20s, buy20≥68%, buy5≥65%, efisiensi arah≥45%, return2 positif. PULLBACK ketika flow20≥65%, drawdown5 1–4%, buyer≥4, top buyer≤50%, dan ada pemulihan/dukungan buy2≥45%. Selain itu DEFENSIVE. Perubahan mode memerlukan persistensi≥1s dan tick berbeda. Max hold awal tidak diperpanjang.

Sell pressure ekstrem (buy share≤25%, sell5≥$150, ≥3 seller, return2 negatif) tidak mendapat grace. Flow reversal biasa: buy share<50%, sell5≥$150, ≥3 seller, return2 negatif; harus terkonfirmasi dua tick berbeda dengan durasi≥500ms. Bukti flow stale tidak dianggap konfirmasi baru. Sigma dan distribusi tidak diketahui berarti tidak ada grace/promosi.

## Eksekusi dan pemisahan waktu

Stake $5; fee model1% per sisi; network0,000205SOL per sisi; gagal0,000105SOL; slippage buy9%/sell14%; delay1s dan stress2s; stress fee tambahan1% per sisi. Kuantitas model, waktu, dan harga buy harus identik pada seluruh exit untuk setiap sinyal/scenario. AGY parity diperiksa terhadap laporan v3. Rent/venue impact/fee belum direkonsiliasi dengan receipt; model bukan fill on-chain.

- Pemilihan/ranking hanya dari data sebelum1Oktober00:00WIB (`2026-09-30T17:00Z`).
- Audit berikutnya1–2Oktober WIB, lalu3Oktober00:00–19:00WIB. Semua periode ini sudah pernah dilihat: **retrospektif**, bukan holdout baru.
- Periode tambahan yang belum diperiksa sebelumnya: **3Oktober19:00–19:55WIB** (`12:00–12:55Z`). Parameter dibekukan sebelum hasil periode ini dibaca. Ini pemeriksaan baru yang pendek, bukan forward trial tujuh hari.
- Purge mint yang sudah terlihat pada periode sebelumnya; buang sinyal180s terakhir; jangan membawa sell yang melewati batas ke bagian sebelumnya. Hasil fresh tidak dipakai memilih ulang aturan.

## Ukuran hasil dan aturan seleksi

Laporkan paired PnL improvement pada cohort yang sama, profit factor, win/loss, loss ekstrem, unknown, dan portofolio satu posisi yang berhenti saat unresolved. Unknown dikenai batas risiko kehilangan stake+biaya untuk statistik konservatif, bukan diklaim sebagai actual loss. Unknown berpasangan juga dilaporkan karena selisih batas konservatif dapat menyesatkan.

Ranking train menggunakan batas bawah resampling blok6jam dari selisih PnL konservatif vs pembanding AGY terbaik di TRAIN secara agregat. Minimum30 posisi selesai/3hari. Syarat kelulusan juga perlu PnL kandidat positif, paired improvement positif terhadap kedua pembanding, dan stress tidak gagal. Ranking tertinggi yang tidak lolos tetap berlabel rejected.

Analisis jam WIB per4jam dan regime bersifat diagnosis. Tidak langsung memilih pemenang setiap sel dari hasil test. Bukti regime/jam membutuhkan sampel≥20 mint pada≥3hari; tanpa itu tidak menerbitkan jadwal trading.

Tidak ada klaim mengalahkan AGY tanpa hasil positif out-of-sample, risiko yang tidak memburuk, dan forward-paper≥100trade pada≥7hari. Nol trade, hanya lebih sedikit loss absolut, atau keuntungan akibat mengabaikan unresolved tidak dihitung sebagai kemenangan.
