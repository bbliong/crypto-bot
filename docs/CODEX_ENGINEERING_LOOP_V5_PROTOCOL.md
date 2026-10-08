# Loop engineering Codex v5 — aturan sebelum pengujian

Dibekukan 4 Oktober 2026 sebelum menjalankan kandidat di bawah. AGY Adaptive Wave V1 tidak diubah. Eksperimen offline, tanpa transaksi atau perubahan collector/config.

Tujuan: mencari perbaikan timing entry dan exit pada opportunity AGY, bukan hanya menumpuk filter. Biaya/fill sama dengan same-entry v4: stake $5, fee 1%/sisi, network 0,000205 SOL/leg, failed 0,000105 SOL, toleransi buy9%/sell14%, delay1s; stress delay2s dan fee2%/sisi. Unknown tetap terpisah dengan batas konservatif full stake+biaya.

Data: seluruh sinyal AGY dalam dua ledger beku sebelumnya yang raw sumbernya masih tersedia. Sumber hilang dilaporkan dan dikeluarkan untuk SEMUA pembanding pada cohort matched-coverage; hasil tersebut tidak boleh digabung seolah mencakup arsip hilang. First-seen mint purge, satu opportunity/mint/24h dan embargo akhir180s tetap berlaku.

TRAIN sebelum 1 Oktober 00 WIB. AUDIT berikutnya sampai 4 Oktober 10 WIB (`03:00Z`) sudah pernah dianalisis, bukan holdout bersih. Pemeriksaan baru tetap `2026-10-04T03:00Z`–`03:30Z`; jangan memilih ulang aturan dari periode ini. Periode sangat pendek tidak memenuhi validasi forward.

Loop A: tepat 12 kombinasi, empat timing entry × tiga exit:

- DIRECT: entry AGY semula.
- CONFIRM_1S dan CONFIRM_3S: tunggu minimal1/3s dari sinyal, dua tick valid berurutan berjarak≥500ms; batas tunggu12s. Recheck snapshot/hardgate, buy5≥60%, buy20≥65%, return2>0, harga≤101% harga sinyal. Bahaya membatalkan setup; tidak melihat berapa lama capture akan tersisa.
- RECLAIM: jendela12s, sempat turun≥1,5% dari harga sinyal, rebound≥1% dari trough yang telah terjadi; kualitas/konfirmasi sama. Tidak averaging down: belum membeli selama menunggu.
- Exit NATIVE: fungsi AGY asli pada posisi entry baru.
- GUARD: native exit ditambah dev sell≥$25/30s, major-holder sell dengan return2≤0, crash≥8%/1s, hardnet−6%, dan batas hold20s. Native tidak ditunda; tidak memperlebar risiko.
- HARVEST: GUARD dengan batas hold12s dan floor peak net≥4%→1%; peak≥8% memakai trailing5%. Floor monoton. Batas hold dihitung dari buy, bukan akhir capture.

Loop B: pemenang eksplorasi TRAIN dari Loop A diuji dengan enam gate entry yang diputuskan saat sinyal awal: ALL, MC≥$25k, AGE≥300s, RETURN5≤5%, SIGMA≤3%, BUYERS≥6. Tepat lima tambahan plus ALL kontrol. Tidak mencari threshold baru. Seleksi harus punya ≥10 trade selesai/≥3 hari hanya untuk ranking eksplorasi; syarat promosi tetap ≥30 selesai/≥3 hari, PnL konservatif positif pada seluruh stress, dan keunggulan/risk terhadap kedua AGY. Jika tak cukup data, tetap ditampilkan tetapi bukan pemenang.

Ranking TRAIN mengutamakan kandidat dengan sampel eksplorasi cukup, kemudian PnL konservatif minimum di tiga skenario. Bekukan pilihan sebelum melihat agregat AUDIT/fresh. Laporkan semua kandidat TRAIN agar multiple testing terlihat. Bootstrap bukan bukti independen setelah pencarian kandidat.

Perbandingan entry berbeda menggunakan opportunity ID yang sama, bukan berpura-pura buy sama. SKIP=tidak mengeluarkan modal, PnL0; jumlah entry/coverage/win/loss/unknown dilaporkan terpisah. Tidak trading bukan kemenangan; kandidat harus profit absolut positif. Portofolio satu posisi tidak menghitung SKIP sebagai transaksi dan berhenti saat unresolved.

Lolos historis atau lebih sedikit rugi bukan selesai. Perlu bukti pada data baru, konsistensi stress dan risiko, lalu ≥100 trade forward di≥7hari. Jika semua gagal, simpan penolakan dan engineering backlog, jangan mengubah angka agar menang. Semua output tetap `liveAllowed=false`.
