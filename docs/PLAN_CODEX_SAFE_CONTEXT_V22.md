# Codex Safe Context v22 — adaptif terhadap kondisi, bukan jam

Status: implementasi **research-only / TRAINING_REJECTED**, evaluasi historis selesai. Tidak dipasang
ke live bot, tidak mengubah lane/collector/config AGY. Nama riset `SAFE_CONTEXT_0`
dan `SAFE_CONTEXT_500`; nama ini bukan lane live yang sudah dapat dipilih di dashboard.

## Formula keputusan

Pada waktu t, gunakan hanya tick/holder/dev yang sudah diterima sampai t.
Entry dasarnya fungsi aggressive-safe existing: momentum positif, buy USD5s>=300,
buyshare5s>=95%, >=4buyer, topbuyer<=70%, return5s1–30%, drawdown<=2,5%, distribusi
holder lolos, dev<=2,5%, buyshare20s>=50%. Adapter mewajibkan holder/dev/count dan
harga fresh. Ini tidak mereplikasi semua cabang collector, khususnya early-holder
growth/reentry; semua pembanding memakai adapter historis yang dijelaskan di protokol.

| Situasi teramati | Mode sebelum buy | Tindakan setelah buy |
|---|---|---|
| Data tidak siap/stale, sigma>6, buy5<60%, atau return2<=0 | WAIT, jangan entry | Tidak menambah posisi; gunakan stop/floor, reversal, bataswaktu |
| Devsell>=25USD, knownmajor sell, atau collapse1s<=−8% | DEFEND, jangan entry | Segera minta sell; fill tetap perlu tick sesudah latency |
| Histori>=20s, buy2/buy5>=70%, efficiency20>=0,6, sigma<=2, return2>0 | RUNNER jika safe entry juga lolos | Ikuti tren, palinglama45s dari buy |
| Entry aman dan momentum positif, tetapi belum memenuhi RUNNER | SCALP | Maksimal15s jika tren kuat tidak bertahan |

`sigma` adalah RMS perubahan logharga bucket1detik dalam jendela20detik,
bukan ukuran volatilitas tahunan. `efficiency20=abs(sum(logReturn))/sum(abs(logReturn))`.
Syarat entry tambahan: biaya pulang-pergi pada harga tetap tidak lebih buruk dari
−3,5% net dalam model base stake$5. Ini batas biaya, **bukan prediksi profit**.
Uji hanya dua varian: entry langsung atau kelayakan bertahan500ms dengan tick berbeda.
Latency eksekusi1/2s dimulai sesudah sinyal final, bukan termasuk500ms konfirmasi.

## Mengubah mode tanpa memperlebar kerugian

- Mode baru harus bertahan>=1detik dan ada tick fresh yang berbeda. Bahaya/hardstop
  tidak menunggu konfirmasi mode.
- Stop model net−6%; gap harga>10s meminta exit. Ini level permintaan, bukan jaminan
  harga eksekusi: gap/rugpull bisa membuat rugi jauh lebih besar atau posisi unresolved.
- Peak net>=4% mengunci floor0,5%; peak>=8% menaikkan floor mengikuti trail.
  Trail SCALP/WAIT3%; RUNNER `clamp(2*sigma,3,7)%`. Floor tidak pernah diturunkan.
- Reversal kuat: buy5<=40%, return2<0, sellUSD>=150, >=3seller, dua tick berbeda
  berjarak>=500ms. Clock hold tetap dihitung dari buy, tidak direset saat berganti mode.
- Satu posisi per portfolio; cooldown15menit sesudah3loss dan batas rugi harian$10
  mengikuti simulator existing. Unknown memblokir portfolio; tidak dianggap posisi tutup.

## Bagaimana menilai “segala waktu”

Formula dapat mengambil keputusan setiap waktu ketika data tersedia; **tidak berarti
profit di semua jam atau semua regime**. Tidak ada pembagian “jamX pakaiY” tanpa bukti.
Laporan memisahkan tanggal/jam, mode awal, perubahan mode, jumlah trade dan unknown.
Sampel jam kosong atau sedikit harus disebut belum teruji, bukan dianggap aman.

Uji seluruh raw tersimpan yang tersedia1Oktober00WIB–4Oktober20:30WIB. TRAIN sebelum
3Oktober12WIB; AUDIT sampai4Oktober10WIB; storedLater sampai20:30WIB. Dataset telah
dipakai riset sebelumnya sehingga bukan holdout independen. Parameter dipilih TRAIN
saja; hasil AUDIT/later tidak dipakai memilih ulang konfigurasi.

Pembanding: AGY native, AGY reference, safe-native independent, dan exit safe-native
pada buy identik untuk mengisolasi efek exit. Semua stake$5/latency/fee sama. Kuotasi
historis positive aggressive-safe lama adalah petunjuk riset, bukan profit formula ini.
Baru layak dipertimbangkan jika profit absolut/risiko/sample lolos seluruh skenario;
model ini tidak membuktikan swap live berhasil tanpa quote/receipt aktual.

Protokol beku: [CODEX_SAFE_CONTEXT_V22_PROTOCOL.md](CODEX_SAFE_CONTEXT_V22_PROTOCOL.md).
Implementasi: `scripts/codex-safe-context-v22.mjs`. Hasil akhir ada pada
`reports/codex-safe-context-v22-summary.json` dan laporan engineering terpusat.

## Hasil pengujian — jangan deploy

14.660detail dari28sumber tersedia;12.869memiliki tick,57akhir sesi inferred.
Primary TRAIN: SAFE_CONTEXT_500; kedua kandidat gagal. Buy/fee/latency identik dengan
kontrol safe-native perentry; AGY memiliki opportunity berbeda. Parity native TRAIN54
dan AUDIT29 cocok studi sebelumnya.

| Periode | Entry | Win/loss | Unknown | Known net base |
|---|---:|---:|---:|---:|
| TRAIN | 62 | 10/41 | 11 | −$20,2248 |
| AUDIT | 19 | 3/12 | 4 | −$2,2936 |
| StoredLater10:00–20:30WIB4Oktober | 11 | 4/5 | 1;1buyfailed | −$0,5792 |

Total92entry,75closed,17win/58loss,16unknown,1buyfailed; knownnet−$23,0975,
conservativebound−$103,4902. Delay2s known−$16,2126; fee2% known−$33,1324.
Ini jumlah independent events, bukan equity portfolio. Portfolio base sebenarnya
memilih4attempt,3closed/3loss−$1,6651, lalu blocked pada unknown; ada1skipcooldown.

Semua92entry terpilih berlabelSCALP. Diantara state posisi yang tersimpan, WAIT muncul
57posisi,SCALP46,DEFEND5 (dapat overlap); **RUNNER0**. Ada43perubahanmode total, namun
perubahanmode bukan bukti profit. Sinyal tersebar pada23jamWIB; jam03tidak memiliki
sinyal. Jangan menyebut modeRUNNER atau semua24jam sudah tervalidasi.

Kesimpulan: kerangka perilaku adaptif selesai, **formula profitable belum ditemukan**.
Tidak boleh melonggarkan syarat RUNNER sesudah melihat data hanya agar mode itu muncul
dan menyebutnya berhasil. Riset berikut membutuhkan hipotesis baru yang dibekukan dan
pembandingan eksekusi yang sama. Implementasi live tetap tidak diizinkan oleh laporan ini.
262tes lulus;typecheck lulus; metadata/case-file hashes disimpan untuk reproduksi.
