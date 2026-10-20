# AGENTS.md — Standing Instructions for AI Agents in `crypto-bot`

## 🚨 Mandatory Operational Rule: Always Commit After Execution (Easy Rollback)

Setiap AI Agent (Hermes, Claude, Antigravity, dsb.) yang bekerja pada repositori `crypto-bot` **WAJIB** mematuhi aturan siklus kerja ini:

1. **Commit Berkala Setelah Tiap Eksekusi Terverifikasi**:
   - Setelah selesai melakukan patch/penambahan file (baik script runner, konfigurasi filter, perbaikan lane, dsb.) dan hasil uji/verifikasi dinyatakan berhasil:
   - **SEGERA lakukan git commit sebelum berpindah ke task/topik berikutnya.**
   - Format commit message: `feat(...)`, `fix(...)`, `refactor(...)`, atau `chore(...)` dengan deskripsi jelas mengenai apa yang diubah.
   - **Tujuan**: Memastikan user atau agent dapat melakukan rollback instan dan aman (`git reset --hard HEAD~1` atau `git checkout <hash>`) jika ada eksperimen atau langkah berikutnya yang menyebabkan regresi.

2. **Dilarang Menumpuk Perubahan (Atomic Steps)**:
   - Kerjakan perbaikan 1 per 1 (one small verified step at a time).
   - Jangan menumpuk perubahan multi-fase atau multi-worker dalam satu status dirty tanpa commit.

3. **Verifikasi Sebelum Mengklaim Sukses**:
   - Selalu periksa log proses (`journalctl`, status file state, port socket, atau DOM via CDP) untuk memastikan perubahan benar-benar aktif di runtime, bukan sekadar tertulis di disk.

---

## 🏗️ Ringkasan Arsitektur Repo Saat Ini

- **Master Chrome Scraper & Feed Hub**:
  - Service: `crypto-bot-chrome-feed.service`
  - Runner: `scripts/run-chrome-feed.mjs` $\rightarrow$ `src/distribution-watch-four-tabs.ts --paperLane feed`
  - Port WebSocket Feed: `ws://127.0.0.1:8765`
  - Chrome Remote Debugging (CDP): `http://127.0.0.1:9223`
  - Tab 1: New Pair (`https://gmgn.ai/trend?chain=sol&ref=bFC8902n&tab=new_pair`) $\rightarrow$ Filter: MC 10k–100k
  - Tab 2: Trending (`https://gmgn.ai/trend?chain=sol&ref=bFC8902n&tab=trending`) $\rightarrow$ Filter: Age $\ge$ 20m, MC $\ge$ 10k, Holders $\ge$ 100

- **Trading Paper Workers (Headless WS Consumers)**:
  - `crypto-bot-momentum-worker.service` (`scripts/run-momentum-worker.mjs`)
  - `crypto-bot-trend20m-worker.service` (`scripts/run-trend20m-worker.mjs`)
  - `crypto-bot-bounce-worker.service` (`scripts/run-bounce-worker.mjs`)
  - `crypto-bot-smartmoney-worker.service` (`scripts/run-smartmoney-worker.mjs`)
  - `crypto-bot-syndicate-worker.service` (`scripts/run-syndicate-worker.mjs`)
  - Seluruh worker ini terpisah dari Chrome dan mengonsumsi feed via WebSocket `ws://127.0.0.1:8765`.
