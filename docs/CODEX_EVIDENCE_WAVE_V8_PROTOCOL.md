# Loop F / Evidence Wave v8: model keputusan dari riwayat as-of

Dibekukan4Oktober2026 sebelum hasil empat model dan replay06:00–06:30UTC dibaca. AGY Native menjadi opportunity/exit control; sumber AGY tidak diubah.

Alasan: gate tunggal bisa membuang trade baik. AGE300 membuang kedua opportunity di fresh04:00–06:00Z ketika AGY menghasilkan+$1,2845. Evaluasi v8 menilai beberapa ciri bersama, dengan kapasitas kecil yang tetap.

Tepat4 hipotesis: decision tree kedalaman1/2 × dua kelompok fitur FLOW/SAFETY. Minimum leaf8, minimum24 hasil historis distinct-mint sebelum keputusan. Target adalah PnL model AGY_NATIVE base termasuk biaya; unknown diberi target risiko kehilangan stake+biaya setelah capture berakhir, diberi label proxy risiko, bukan loss terealisasi. Tidak melatih pada hasil yang belum tersedia.

FLOW: return5, buy5, buy20, sigma, efficiency, log(1+buyUsd), log(1+buyers). SAFETY: log(1+age), log(1+MC), top1, dev, sigma. Missing-value imputer menggunakan median TRAIN/prefix saja. Split mencari penurunan squared error dengan tie-break deterministik; minimum improvement0,02USD². Leaf mean ditarik ke mean global dengan prior8 observasi. Entry diizinkan jika expected model PnL>$0,04. Threshold bukan probabilitas profit terkalibrasi.

TRAIN54 opportunity sebelum3Oktober12WIB dari cache matched. Evaluasi TRAIN wajib prequential: pada setiap opportunity, model hanya fit outcome sebelumnya yang availableAt<signalAt, maksimal satu label/mint/24h. Closed/failed outcome tersedia di fill/failure time; unknown proxy baru tersedia di captureEnd. Uji base/delay2s/fee2% memakai keputusan yang sama dan model fee/fill yang sama dengan versi sebelumnya. Model final fit TRAIN yang sudah available sebelumtrainEnd, lalu dibekukan.

Rank empat policy berdasarkan minimum conservative PnL tiga skenario prequential TRAIN, dahulukan≥10closed/3hari untuk eksplorasi dan buang policy dengan nol entry. Jika seluruh model abstain, pilihan utama null dan status NO_ACTIVE_TRAINING_MODEL. Untuk pemeriksaan perilaku shadow, model depth1 SAFETY boleh direkam dengan label diagnostic-only tanpa mengubah selection tersebut. Tidak menganggap tidak trading sebagai menang.

AUDIT29 opportunity sesudahtrainEnd sampai4Oktober10WIB sudah terpakai, hanya diagnosis. Pemeriksaan baru06:00–06:30UTC (13:00–13:30WIB) dipindai setelah selection/model JSON disimpan. Skip mint yang first-seen sebelum06:00, embargo180s, jangan fillmelewatibatas. Tidak melakukan fit ulang padaAUDIT/fresh.

Kandidat memakai native entry dan exit ketika model mengizinkan; manfaat diuji dari pengambilan keputusan, bukan mengklaim exit berbeda. Entry waktu/harga/quantity sama dengan native pada kesempatan yang dieksekusi. Portofolio unresolved memblokirentryberikutnya. Harga dan biaya adalah modelsocket, bukanreceipt.

Promosi tetap membutuhkan≥30closed/3hari, positive absolute PnL dan risk/stress yang konsisten terhadap dua kontrol, lalu100trade/7hari forward. Keuntungan training setelah fittingfull-model tidak digunakan untuk ranking (in-sample bias). Total hipotesis kumulatif37. Tidak ada pemilihan ulang dari periode baru.
