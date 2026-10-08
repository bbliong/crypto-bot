# Codex Cost Tempo v12 — protokol sebelum hasil

Dibekukan 4 Oktober 2026 setelah 51 keluarga hipotesis v5–v11. Tidak mengubah AGY, konfigurasi live, collector, dashboard, atau service. Empat hipotesis tambahan, total 55; bukan 55 uji statistik independen. Semua tanggal historis di bawah sudah dieksplorasi dan bukan holdout.

Tujuan: mencari momentum independen pada seluruh detail, bukan hanya token yang kemudian lolos AGY. Mengatasi biaya dengan gate eksplisit, lalu memilih tempo exit dari flow yang saat itu terlihat. Skor momentum di sini heuristik, bukan ramalan terkalibrasi atau bukti profit.

## Entry tetap

Universe DETAIL_STARTED 1 Oktober 00 WIB–4 Oktober 10 WIB dari semua raw tersedia. Metadata sebelumnya dipertahankan untuk purge mint lama. TRAIN sebelum 3 Oktober 12 WIB, AUDIT berikutnya sampai 4 Oktober 10 WIB. Gunakan hanya data diterima/as-of, MC/holder/dev adapter bersama. Setup dicari selama 60 detik pertama, konfirmasi dua tick berbeda berjarak sedikitnya 500ms; satu setup/profile/detail. Tidak melihat panjang/akhir capture untuk memilih entry.

Hard quality sama entryQualityV5: MC $10k–100k, age ≥60s, holders ≥100, top1 ≤8%, top5 ≤25%, dev ≤2,5%, fresh snapshot/tape, ≥4 buyer/5 trade, buy USD ≥300, buyer terbesar ≤50%, drawdown5 ≤2,5%, return2 >0, buy5 ≥60%, buy20 ≥65%. Tolak dev sell ≥$25/30s, major sell, atau collapse1 ≤−8%. Tambahan return5 0,5–12%, sigma1 0–4%, efficiency20 ≥0,35.

`v = min(100*log1p(return2/100)/2, 100*log1p(return5/100)/5)` dalam log-persen/detik. Horizon entry H: 3s jika sigma ≥3, 5s jika sigma ≥1,5, lainnya 8s. Break-even gross dihitung dari model linear nilai likuidasi terhadap harga, stake $5, fee1%/sisi dan network .000205 SOL/leg, menggunakan SOL/USD as-of (fallback120 dinyatakan). `gross = 100*expm1(v*H/100)`. `edge = gross − grossBreakEven − lambda*sigma*sqrt(H+1)`. Entry hanya edge ≥1 poin persentase. Semua ini diketahui sebelum order; hasil fill tidak menjadi gate gratis.

Tepat empat konfigurasi lambda 0,25/0,50 × exit PEAK_CONTROL/TEMPO. Lambda tidak disetel ulang dari AUDIT. Sinyal entry identik untuk dua exit pada lambda yang sama. PEAK_CONTROL memakai exit native dengan pembaruan peak dalam adapter Codex (v10), bukan mengedit source AGY.

## Exit TEMPO

Mode RUNNER jika buy2 ≥70%, buy5 ≥70%, efficiency ≥0,60, return2 >0, sigma ≤2; lainnya SCALP. Promosi membutuhkan mode stabil 1s dan tick berbeda. Weakness langsung boleh memperketat floor, tetapi tidak melonggarkan floor/risk/batas hold awal. Maxhold awal RUNNER45s, SCALP15s.

Hard net −6%, dev/major dump atau flash meminta exit; price silence10s diberi label gap harga, bukan socket disconnected. Peak aktual net hanya dari harga diterima sesudah buy. Peak ≥4% mengunci floor+0,5%; peak ≥8% trail SCALP3%, RUNNER clamp(2*sigma,3,7)%, floor minimal+1%. Floor monoton. Flow sell≥$150/5s dan≥3seller, buy5≤40%, return2<0, bertahan500ms dengan tick berbeda meminta exit. Stagnasi10s, peak<2%, buy5<60% juga exit. Sinyal exit bukan jaminan fill, apalagi pada rugpull.

## Evaluasi dan pemilihan

Shared replay stake$5, delay1s/delay2s, fee1%/fee2% stress; buy9%/sell14% adalah toleransi min-output, bukan haircut. Unknown dilaporkan dan bound risiko full stake+biaya; bukan realized loss. Portfolio satu posisi/cooldown/dayloss/unresolved terpisah dari total event. Satu attempt/mint/24h, first-seen purge dan embargo180s sama bagi tiap lane; sinyal independen tidak disebut paired same-entry dengan AGY.

Bekukan ranking TRAIN sebelum agregasi AUDIT: utamakan ≥10closed/3hari untuk diagnostic selection, lalu minimum conservative PnL tiga skenario, lalu jumlah closed. Bila tidak ada active candidate selected=null. Promosi harus ≥30closed/3hari, absolute net positif, lebih baik dari AGY_NATIVE dan AGY_REFERENCE pada ketiga skenario tanpa memperburuk drawdown/tail/unknown. Sampel nol bukan kemenangan. Promosi historis tetap membutuhkan ≥100 trade/≥7hari forward serta coverage eksekusi/quote nyata; historical audit bukan pembuktian final.

Forward reserved mulai 4 Oktober 14 WIB (07:00 UTC), bukan membaca hasilnya dalam seleksi ini. Jika selesai coding/seleksi sesudah 07:00 UTC, masa forward baru hanya mulai setelah timestamp selection. Jangan relabel data yang sudah dibaca sebagai baru. Simpan source/dependency hash, selection timestamp sebelum audit, inventory missing dan kasus replay. Semua output baru eksklusif, tidak menimpa laporan lama.
