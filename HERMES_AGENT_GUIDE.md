# Panduan Operasional Hermes Agent — Project Crypto-Bot (Profit4 & Multi-Lane Engine)

> **Dokumen Panduan Sistem & Instruksi Agent**: Dokumen ini dirancang khusus sebagai panduan konteks kerja, instruksi operasional, dan playbook troubleshooting untuk **Hermes Agent** (atau autonomous AI coding agent lainnya) saat berinteraksi dengan user di repositori `crypto-bot`.

---

## 1. Ringkasan Eksekutif & Arsitektur Project

### 1.1 Apa itu Crypto-Bot?
`crypto-bot` adalah sistem automated algorithmic trading & paper monitor token Solana (fokus pada meme token / pump tokens) yang mengintegrasikan:
1. **Target Wallet Monitor (Smart Money Tracking)**: Memantau perpindahan token dari wallet distribusi / developer / early insiders secara on-chain (`transfers.jsonl`).
2. **GMGN WebSocket Streamer**: Menerima tick per tick harga, likuiditas, swap trades, dan volume order book dari GMGN secara real-time (`token-trades.jsonl`, `websocket-frames.jsonl`).
3. **Multi-Lane Strategy Engine**:
   - **Lane P4 (`DistributionProfit4Lane`)**: Momentum target profit bersih +4% (net setelah estimasi fee 1%/sisi + slippage), SL -5%, max holding 300s.
   - **Lane V1–V4 (`DistributionBounceLane`)**: Menangkap bounce setelah dump tajam (30–40% dump dari peak), staircase confirmation, dynamic profit target (18%–40%), dan proteksi whale sell.
   - **Lane V5 (`DistributionBounceLaneV5`)**: Filter anti-rugpull ketat (cek sisa suplai dev balance, whale sell cooldown 45 detik, deteksi penurunan holder cepat).
4. **Real Execution Engine (`src/profit4-live-engine.ts`)**:
   - Mengeksekusi order buy/sell melalui sesi browser Google Chrome aktif di GMGN (Playwright + Xvfb display `:99`) tanpa menyimpan Solana private key on-server.
   - Membaca saldo SOL real-time via Solana RPC dan mencatat on-chain cashflow di `data/profit4-watch/real-trade-ledger.jsonl`.
5. **Web Dashboard (`scripts/serve-profit4-dashboard.mjs`)**:
   - Dashboard analitik 4-tab di port default `4178` (Ringkasan, Posisi Aktif, Riwayat Transaksi, On-Chain & Auto-Buy).

---

## 2. Pola Interaksi Utama: "User Minta Trace -> Agent Lakukan Streaming Test"

User sering kali memberikan instruksi singkat seperti:
- *"trace token [mint_address]"*
- *"trace drawdown token ini kenapa loss"*
- *"trace data s3 untuk tanggal 12-13 oktober"*
- *"coba streaming test perubahan lane v5 vs v1"*
- *"kenapa token ini ke-trigger buy lalu timeout?"*

### 2.1 Peran Hermes Agent saat Menerima Perintah "Trace"
Ketika user meminta **trace**:
1. **Pahami Maksud Trace**:
   Trace berarti menelusuri siklus hidup lengkap suatu trade atau sekumpulan token:
   - Kapan transfer target terjadi (`transferAt`).
   - Kapan bot mulai mengamati token (`observation window`).
   - Harga peak sebelum buy, harga trough (titik terendah), dan drawdown saat buy terjadi.
   - Alasan buy terpicu (staircase confirmation, volume buy vs sell, lane yang mengeksekusi).
   - Perkembangan harga setelah buy (apakah sempat naik menyentuh TP atau langsung turun menyentuh SL).
   - Alasan exit (`TAKE_PROFIT`, `STOP_LOSS`, `TIMEOUT`, `WHALE_SELL_PROTECT`, `TRAIL_SL`).
   - Slippage dan net return % setelah fee.
2. **JANGAN Download File S3 Raksasa ke Disk Lokal!**:
   Chunk data GMGN menyimpan `websocket-frames.jsonl` yang sangat besar (300 MB – 500 MB per chunk 30 menit). Bucket S3 memiliki puluhan hingga ratusan chunk (puluhan GB).
3. **Wajib Menggunakan In-Memory Streaming**:
   Hermes Agent harus melakukan **streaming** via pipe command (`aws s3 cp ... - | tar -zx -O ...` atau Python / Node stream) langsung ke memori untuk mengekstrak hanya baris JSON yang relevan (`token-trades.jsonl` atau `profit4-events.jsonl`).
4. **Streaming Test / Live Feedback**:
   Saat mengeksekusi test / backtest, Hermes Agent harus menampilkan progres secara streaming (misal: `[1/50] Streaming chunk 2026-10-12... total buys=..., total sells=...`) sehingga user tahu proses berjalan dan tidak freeze.
5. **Format Laporan Trace**:
   Sajikan hasil trace dalam bentuk tabel terstruktur Markdown yang padat, memuat:
   - Symbol & Mint
   - Entry Price, Peak Price, Drawdown at Buy %
   - Exit Reason, Exit Price, Holding Time (detik)
   - Gross PnL %, Net PnL %, Status (WIN / LOSS / BLOCKED)

---

## 3. Peta Direktori & Tempat Data Berada

### 3.1 Data Lokal (`data/profit4-watch/`)
| Path | Deskripsi |
| :--- | :--- |
| `data/profit4-watch/historical_target_trades.json` | Metadata token target historis yang pernah dipantau (mint, symbol, transferAt, dll). |
| `data/profit4-watch/cached-mints/<mint>.jsonl` | Trade trades spesifik per token mint yang sudah di-cache secara lokal. |
| `data/profit4-watch/real-trade-ledger.jsonl` | Ledger transaksi real on-chain (signature, buy/sell SOL, fee, lamport delta). |
| `data/profit4-watch/real-state.json` | State posisi bot live saat ini (posisi terbuka, balance SOL, order aktif). |
| `data/profit4-watch/worker-control.json` | Kontrol status live bot (`{"status":"running"}`). |
| `data/profit4-watch/<run-id>/chunks/<chunk-timestamp>/` | Direktori chunk aktif yang belum diarsipkan ke S3. |

Isi setiap folder chunk:
- `chunk.json`: Metadata rentang waktu chunk.
- `transfers.jsonl`: Transfer token target yang masuk ke watcher.
- `profit4-events.jsonl`: Event trading (`PAPER_BUY`, `PAPER_SELL`, `REAL_BUY`, dll).
- `token-trades.jsonl`: Feed transaksi swap token (harga, volume USD, maker).
- `websocket-frames.jsonl`: Raw frames websocket (sangat besar, hindari membaca seluruh file).

### 3.2 Data Remote S3 (DigitalOcean Spaces)
- **Bucket**: `s3://missi/crypto/profit4-chunks/`
- **AWS Profile**: `do-tor1`
- **Format**: File arsip `.tar.gz` berisi satu folder chunk lengkap.
- **Pengecekan file S3**:
  ```bash
  aws --profile do-tor1 s3 ls s3://missi/crypto/profit4-chunks/ --recursive
  ```

---

## 4. Playbook Script & Perintah untuk Tracing & Streaming Test

### 4.1 Trace Token & Drawdown di S3 via Streaming Python
Gunakan script pattern streaming tarfile agar tidak membebani storage lokal:

```python
# Contoh: Stream & cari trade token di S3 secara on-the-fly
import subprocess, tarfile, json

cmd = ["aws", "--profile", "do-tor1", "s3", "cp", "s3://missi/crypto/profit4-chunks/<chunk_name>.tar.gz", "-"]
p = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)

with tarfile.open(fileobj=p.stdout, mode="r|gz") as tar:
    for entry in tar:
        if entry.name.endswith("profit4-events.jsonl"):
            f = tar.extractfile(entry)
            if f:
                for line in f:
                    ev = json.loads(line.decode("utf-8", errors="ignore"))
                    if ev.get("mint") == TARGET_MINT:
                        print("Found event:", ev["type"], ev.get("priceUsd"))
p.terminate()
```

Script bawaan yang siap pakai:
- `find_all_s3_trades_stream.py`: Melakukan streaming chunk S3 untuk mengambil semua `PAPER_BUY` dan `PAPER_SELL`.
- `find_all_drawdowns_at_buy.py`: Menghitung peak price sebelum buy, buy price, dan drawdown percentage saat eksekusi buy.
- `find_all_profit4_events_s3.py`: Streaming semua event Profit4 dari S3.

### 4.2 Streaming Backtest & Multi-Lane Simulation
Untuk menguji perubahan aturan (misal parameter Lane V5 atau strategi bounce baru) terhadap data historis S3:
```bash
# Streaming backtest langsung membaca chunk dari S3
node --import tsx scripts/run-s3-streaming-backtest.mjs

# Streaming backtest versi parallel (lebih cepat)
node --import tsx scripts/run-s3-streaming-backtest-parallel.mjs

# Simulasi evaluasi trade target
node --import tsx scripts/simulate-option2-relax.mjs

# Ringkasan hasil backtest (Win Rate, PnL perbandingan, token scam yang diblokir)
python3 scripts/summarize-backtest.py
```

### 4.3 Menjalankan Unit & Integration Test
Selalu verifikasi kode TypeScript sebelum melaporkan ke user:
```bash
# 1. Typecheck TypeScript
npm run typecheck

# 2. Test Multi-Lane Bounce Logic
node --import tsx --test tests/distribution-bounce-lane.test.ts

# 3. Test Real Execution Engine & Live API
node --import tsx --test tests/profit4-live.test.ts tests/profit4-gmgn-execution.test.ts

# 4. Test Dashboard Server
node --import tsx --test tests/profit4-dashboard.test.mjs
```

### 4.4 Menjalankan Bot & Dashboard
```bash
# Menjalankan Paper / Real Watcher:
npm run wallet:profit4-watch

# Menjalankan Web Dashboard (Port 4178):
npm run dashboard:profit4
```

---

## 5. Pedoman Respon & Standar Output Hermes Agent

Ketika user meminta trace atau streaming test:

### 5.1 Format Output Trace Token Spesifik
Saat user meminta: *"Hermes, trace token [Symbol/Mint]"*:
Berikan respon dengan struktur:

```markdown
### 🔍 Trace Analisis Token: [SYMBOL] (`[MINT]`)

| Parameter | Nilai | Catatan |
| :--- | :--- | :--- |
| **Transfer Time** | `2026-10-14 09:12:04 WIB` | Transfer dari wallet target `...xyz` |
| **Buy Time & Lane** | `2026-10-14 09:12:35 WIB` (`Lane V5`) | Entry terkonfirmasi setelah 31 detik |
| **Buy Price** | `$0.0004210` | Fills price dihitung dari swap pool |
| **Peak Before Buy** | `$0.0006500` | Titik tertinggi sebelum dump |
| **Drawdown at Buy** | `-35.23%` | Memenuhi syarat filter dump 30-40% |
| **Exit Time & Reason** | `2026-10-14 09:15:10 WIB` (`TAKE_PROFIT`) | Target tercapai |
| **Exit Price** | `$0.0005150` | Dynamic target 22% |
| **Gross PnL** | `+22.32%` | PnL kotor |
| **Net PnL (Est. Fee)**| `+20.12%` | Setelah fee 1%/sisi + slippage |

#### ⏱️ Timeline Perjalanan Harga (Price Action)
1. **09:12:04** - Token transfer terdeteksi ($0.000650).
2. **09:12:15** - Dump tajam terjadi hingga trough $0.000390 (-40.0%).
3. **09:12:30** - Bounce confirmation stair: 3 candle hijau berturut-turut.
4. **09:12:35** - **PAPER_BUY** dieksekusi di $0.0004210.
5. **09:15:10** - **TAKE_PROFIT** terpicu di $0.0005150 (+22.3%).
```

### 5.2 Format Output Ringkasan Streaming Backtest
Saat selesai menjalankan streaming backtest:
```markdown
### 📊 Hasil Streaming Backtest S3: [Nama Aturan / Perubahan Lane]

- **Total Token Diuji**: `142 Token` (Periode 10 - 13 Oktober)
- **Token Lolos Filter (Executed)**: `38 Token`
- **Token Terblokir (Filter Anti-Rug)**: `104 Token`
  - *Menghindari Kerugian (Saved Loss)*: `+62 Token (Modal terselamatkan: +$145.20 USD)`
- **Win Rate Baru**: `71.1%` (27 Win / 11 Loss) vs Aturan Lama `58.2%`
- **Total PnL Bersih**: `+$188.40 USD` (Kenaikan `+34.2%`)
```

---

## 6. Aturan Ketat & Batasan Teknis (Guardrails)

1. **Node.js Environment**:
   - Sistem membutuhkan `node >= 22.13.0` karena menggunakan fitur bawaan `node:sqlite`. Jangan downgrade versi Node.
2. **Kerahasiaan Kunci & Keamanan**:
   - Dilarang keras mencatat atau mengekspos private key Solana di terminal atau log.
   - Live trading menggunakan profil Chrome headed (`profiles/research-vps/`) dengan wallet terhubung via ekstensi/web UI.
3. **Penyimpanan Disk & S3**:
   - Hindari mengekstrak seluruh arsip `websocket-frames.jsonl` ke disk server. Gunakan pipe atau filter hanya baris yang dibutuhkan.
4. **Integritas Dokumentasi**:
   - Jangan menghapus komentar atau docstrings yang ada di kode sumber.
   - Jalankan `npm run typecheck` setiap kali melakukan perubahan pada file `.ts` atau `.mjs`.
