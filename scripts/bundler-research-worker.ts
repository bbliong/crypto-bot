import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import WebSocket from 'ws';

// Direktori output data riset
const DATA_DIR = path.resolve(process.cwd(), 'data');
const TIMESERIES_FILE = path.join(DATA_DIR, 'research-bundler-timeseries.jsonl');
const SUMMARY_FILE = path.join(DATA_DIR, 'research-bundler-summary.json');

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

interface BundlerSample {
  mint: string;
  symbol: string;
  sampleIndex: number;
  timestamp: number;
  timeWib: string;
  ageSeconds: number;
  bundlerPct: number;
  prevBundlerPct: number | null;
  deltaBundlerPct: number;
  status: 'STABLE' | 'INCREASED' | 'DECREASED';
  holders: number;
  sniperHoldPct: number;
  creatorHoldPct: number;
  freshWalletPct: number;
  top10Pct: number;
}

interface TokenTrackState {
  mint: string;
  symbol: string;
  firstSeenAt: number;
  lastPolledAt: number;
  sampleCount: number;
  initialBundlerPct: number;
  latestBundlerPct: number;
  minBundlerPct: number;
  maxBundlerPct: number;
  hasIncreased: boolean;
  hasDecreased: boolean;
  maxDelta: number;
  samples: BundlerSample[];
}

function formatWib(ms: number): string {
  const d = new Date(ms + 7 * 3600 * 1000);
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mm = String(d.getUTCMinutes()).padStart(2, '0');
  const ss = String(d.getUTCSeconds()).padStart(2, '0');
  return `${hh}:${mm}:${ss} WIB`;
}

class BundlerResearchWorker {
  private cdpUrl = 'http://127.0.0.1:9223';
  private trackingTokens: Map<string, TokenTrackState> = new Map();
  private maxTrackDurationMs = 30 * 60 * 1000; // Track hingga 30 menit per token
  private pollIntervalMs = 5000; // Polling setiap 5 detik
  private isPolling = false;

  constructor() {
    this.loadExistingSummary();
  }

  private loadExistingSummary(): void {
    if (fs.existsSync(SUMMARY_FILE)) {
      try {
        const raw = JSON.parse(fs.readFileSync(SUMMARY_FILE, 'utf8'));
        if (Array.isArray(raw)) {
          for (const item of raw) {
            this.trackingTokens.set(item.mint, {
              ...item,
              samples: []
            });
          }
        }
      } catch {}
    }
  }

  private saveSummary(): void {
    try {
      const summaryList = Array.from(this.trackingTokens.values()).map(t => ({
        mint: t.mint,
        symbol: t.symbol,
        firstSeenAt: t.firstSeenAt,
        firstSeenWib: formatWib(t.firstSeenAt),
        sampleCount: t.sampleCount,
        initialBundlerPct: t.initialBundlerPct,
        latestBundlerPct: t.latestBundlerPct,
        minBundlerPct: t.minBundlerPct,
        maxBundlerPct: t.maxBundlerPct,
        hasIncreased: t.hasIncreased,
        hasDecreased: t.hasDecreased,
        maxDelta: t.maxDelta,
      }));
      fs.writeFileSync(SUMMARY_FILE, JSON.stringify(summaryList, null, 2), 'utf8');
    } catch (e: any) {
      console.warn(`[SUMMARY SAVE ERR] ${e?.message}`);
    }
  }

  private appendSample(sample: BundlerSample): void {
    try {
      fs.appendFileSync(TIMESERIES_FILE, JSON.stringify(sample) + '\n', 'utf8');
    } catch (e: any) {
      console.warn(`[TIMESERIES SAVE ERR] ${e?.message}`);
    }
  }

  /**
   * Evaluasi langsung ke Chrome GMGN via CDP port 9223
   */
  private async queryTokenStat(mint: string): Promise<any | null> {
    try {
      const tabsRes = await fetch(`${this.cdpUrl}/json`, { signal: AbortSignal.timeout(1000) });
      if (!tabsRes.ok) return null;
      const tabs: any = await tabsRes.json();
      const pageTab = tabs.find((t: any) => t.type === 'page' && t.url && t.url.includes('gmgn.ai'));
      if (!pageTab || !pageTab.webSocketDebuggerUrl) return null;

      return await new Promise((resolve) => {
        const timer = setTimeout(() => {
          try { ws.close(); } catch {}
          resolve(null);
        }, 2000);

        const ws = new WebSocket(pageTab.webSocketDebuggerUrl);
        ws.onopen = () => {
          const expr = `(async () => {
            try {
              const r = await fetch('/api/v1/token_stat/sol/${mint}');
              const j = await r.json();
              return j?.data;
            } catch { return null; }
          })()`;
          ws.send(JSON.stringify({
            id: 777,
            method: 'Runtime.evaluate',
            params: { expression: expr, awaitPromise: true, returnByValue: true }
          }));
        };

        ws.onmessage = (evt) => {
          try {
            const data = JSON.parse(evt.data.toString());
            if (data.id === 777) {
              clearTimeout(timer);
              ws.close();
              resolve(data.result?.result?.value || null);
            }
          } catch {
            clearTimeout(timer);
            try { ws.close(); } catch {}
            resolve(null);
          }
        };

        ws.onerror = () => {
          clearTimeout(timer);
          resolve(null);
        };
      });
    } catch {
      return null;
    }
  }

  /**
   * Daftarkan token baru untuk mulai dipantau setiap 5 detik
   */
  public registerToken(mint: string, symbol: string = 'UNKNOWN'): void {
    if (!mint || mint.length < 32) return;
    if (this.trackingTokens.has(mint)) {
      const state = this.trackingTokens.get(mint)!;
      // Jika token sudah selesai dipantau > 30m, perpanjang jika ada sinyal baru
      if (Date.now() - state.firstSeenAt > this.maxTrackDurationMs) {
        state.firstSeenAt = Date.now();
        console.log(`[BUNDLER WORKER] 🔄 Melanjutkan pemantauan kembali: ${symbol} [${mint.slice(0, 8)}...]`);
      }
      return;
    }

    const now = Date.now();
    const state: TokenTrackState = {
      mint,
      symbol,
      firstSeenAt: now,
      lastPolledAt: 0,
      sampleCount: 0,
      initialBundlerPct: -1,
      latestBundlerPct: -1,
      minBundlerPct: 999,
      maxBundlerPct: -1,
      hasIncreased: false,
      hasDecreased: false,
      maxDelta: 0,
      samples: []
    };

    this.trackingTokens.set(mint, state);
    console.log(`\n=========================================================`);
    console.log(`🔬 [BUNDLER RESEARCH WORKER: REGISTERED NEW TOKEN]`);
    console.log(`   Token       : ${symbol} [${mint.slice(0, 8)}...]`);
    console.log(`   Target Poll : Setiap 5 Detik (/api/v1/token_stat/sol/)`);
    console.log(`   Mulai Pada  : ${formatWib(now)}`);
    console.log(`=========================================================\n`);

    // Poll langsung detik pertama
    this.pollSingleToken(state).catch(() => {});
  }

  /**
   * Poll 1 token dan catat perubahannya
   */
  private async pollSingleToken(state: TokenTrackState): Promise<void> {
    const now = Date.now();
    const ageSeconds = Math.round((now - state.firstSeenAt) / 1000);
    const data = await this.queryTokenStat(state.mint);
    if (!data) return;

    state.lastPolledAt = now;
    state.sampleCount++;

    const bundlerRaw = data.top_bundler_trader_percentage;
    const bundlerPct = bundlerRaw !== undefined && bundlerRaw !== null ? Number(bundlerRaw) * 100 : 0;
    const holders = Number(data.holder_count || 0);
    const sniperHoldPct = Number(data.top70_sniper_hold_rate || 0) * 100;
    const creatorHoldPct = Number(data.creator_hold_rate || 0) * 100;
    const freshWalletPct = Number(data.fresh_wallet_rate || 0) * 100;
    const top10Pct = Number(data.top_10_holder_rate || 0) * 100;

    let prevPct = state.latestBundlerPct >= 0 ? state.latestBundlerPct : null;
    let delta = prevPct !== null ? (bundlerPct - prevPct) : 0;
    let status: 'STABLE' | 'INCREASED' | 'DECREASED' = 'STABLE';

    if (state.initialBundlerPct < 0) {
      state.initialBundlerPct = bundlerPct;
      state.minBundlerPct = bundlerPct;
      state.maxBundlerPct = bundlerPct;
    } else {
      if (bundlerPct > state.maxBundlerPct) state.maxBundlerPct = bundlerPct;
      if (bundlerPct < state.minBundlerPct) state.minBundlerPct = bundlerPct;

      if (delta > 0.05) {
        status = 'INCREASED';
        state.hasIncreased = true;
      } else if (delta < -0.05) {
        status = 'DECREASED';
        state.hasDecreased = true;
      }
      const absDelta = Math.abs(bundlerPct - state.initialBundlerPct);
      if (absDelta > state.maxDelta) state.maxDelta = absDelta;
    }

    state.latestBundlerPct = bundlerPct;

    const sample: BundlerSample = {
      mint: state.mint,
      symbol: state.symbol,
      sampleIndex: state.sampleCount,
      timestamp: now,
      timeWib: formatWib(now),
      ageSeconds,
      bundlerPct: Number(bundlerPct.toFixed(2)),
      prevBundlerPct: prevPct !== null ? Number(prevPct.toFixed(2)) : null,
      deltaBundlerPct: Number(delta.toFixed(2)),
      status,
      holders,
      sniperHoldPct: Number(sniperHoldPct.toFixed(2)),
      creatorHoldPct: Number(creatorHoldPct.toFixed(2)),
      freshWalletPct: Number(freshWalletPct.toFixed(2)),
      top10Pct: Number(top10Pct.toFixed(2))
    };

    this.appendSample(sample);
    this.saveSummary();

    // Print highlight jika ada kenaikan / penurunan
    if (status === 'INCREASED') {
      console.log(`📈 [BUNDLER MENINGKAT! #${state.sampleCount} | +${ageSeconds}s] ${state.symbol} [${state.mint.slice(0, 8)}..]: ${prevPct?.toFixed(2)}% -> ${bundlerPct.toFixed(2)}% (+${delta.toFixed(2)}%) | Holders: ${holders}`);
    } else if (status === 'DECREASED') {
      console.log(`📉 [BUNDLER TURUN! #${state.sampleCount} | +${ageSeconds}s] ${state.symbol} [${state.mint.slice(0, 8)}..]: ${prevPct?.toFixed(2)}% -> ${bundlerPct.toFixed(2)}% (${delta.toFixed(2)}%) | Holders: ${holders}`);
    } else {
      // Print rutin setiap 3 sample (setiap 15s) agar terminal tidak terlalu spam, tapi tetap terlihat
      if (state.sampleCount % 3 === 1) {
        console.log(`📊 [SAMPLE #${state.sampleCount} | +${ageSeconds}s] ${state.symbol.padEnd(8)} [${state.mint.slice(0, 8)}..] | Bundler: ${bundlerPct.toFixed(2)}% (STABIL) | Holders: ${holders} | Snipers: ${sniperHoldPct.toFixed(1)}% | Dev: ${creatorHoldPct.toFixed(1)}%`);
      }
    }
  }

  /**
   * Main Loop: Melakukan query setiap 5 detik untuk semua token aktif (< 30 menit)
   */
  public startPollingLoop(): void {
    if (this.isPolling) return;
    this.isPolling = true;

    setInterval(async () => {
      const now = Date.now();
      for (const [mint, state] of this.trackingTokens.entries()) {
        const age = now - state.firstSeenAt;
        if (age <= this.maxTrackDurationMs) {
          await this.pollSingleToken(state);
        }
      }
    }, this.pollIntervalMs);
  }

  /**
   * Mendengarkan token baru dari Log Service Follower secara live (journalctl tail)
   */
  public startLogTailListener(): void {
    console.log(`[BUNDLER WORKER] 👂 Mendengarkan feed token baru dari follower service (journalctl stream)...`);
    
    const cmd = spawn('journalctl', ['--user-unit=crypto-bot-wallet-follower.service', '-f', '-n', '20'], {
      stdio: ['ignore', 'pipe', 'ignore']
    });

    cmd.stdout.on('data', (chunk: Buffer) => {
      const lines = chunk.toString().split('\n');
      for (const line of lines) {
        // Deteksi pola token buy target
        // Contoh: [TARGET ACTIVITY] BUY VIBE (AkSM8h6z...)
        if (line.includes('BUY') && (line.includes('TARGET ACTIVITY') || line.includes('DEV-RADAR TRIGGER') || line.includes('FIRST_BUY'))) {
          const matchSym = line.match(/BUY\s+([A-Za-z0-9_\$]+)\s+\(([A-Za-z0-9]{8,})/);
          if (matchSym) {
            const sym = matchSym[1];
            const mintPref = matchSym[2];
            // Temukan full mint dari log jika ada
            const fullMintMatch = line.match(/\[([A-Za-z0-9]{32,44})\]/);
            const fullMint = fullMintMatch ? fullMintMatch[1] : null;
            if (fullMint) {
              this.registerToken(fullMint, sym);
            }
          }
        }
        // Deteksi dari GMGN Raw item jika ada
        if (line.includes('Raw:') && line.includes('"a":"')) {
          try {
            const rawStr = line.slice(line.indexOf('Raw:') + 4).trim();
            const json = JSON.parse(rawStr);
            if (json.a && json.a.length >= 32) {
              const sym = json.bs || json.bn || 'UNKNOWN';
              this.registerToken(json.a, sym);
            }
          } catch {}
        }
      }
    });

    cmd.on('error', (err) => {
      console.warn(`[JOURNAL LOG TAIL ERR] ${err.message}`);
    });
  }

  /**
   * Daftarkan token-token aktif yang baru lahir hari ini (VIBE, RING, MEOW, dll) untuk langsung ditracking
   */
  public registerRecentTokens(): void {
    const recents = [
      { sym: 'VIBE-G1', mint: 'AkSM8h6z1PVMTDhZfaBcAzAWNNtJ1mnbjnfK4HRGcPVA' },
      { sym: 'VIBE-G2', mint: 'AsSsfuPL3TrozxN9X1i9hFf3qpYWrRKJo4nrKamfGM1y' },
      { sym: 'RING-G3', mint: 'Goh4ZhFavJoGEr2reYTUowARLdbLyLBjX63mbiZHRcSv' },
      { sym: 'RING-G4', mint: 'FSkVC8NXpMeA47pjewohWF6TC4CaqiWpBQKWHuW7aqUE' },
      { sym: 'MEOW-W', mint: 'CnvGLjxhw8Z7Qj2fj4uvHtcSL7uJdkfRdhG55L1qZjKs' },
      { sym: 'PEPETIDE', mint: 'CsvsmGM3usM4W7sD9UEa5MEcrAs7yZ9YgsHAHKoNczeg' },
    ];

    console.log(`[BUNDLER WORKER] 📋 Mendaftarkan ${recents.length} token sample aktif untuk observasi komparasi...`);
    for (const t of recents) {
      this.registerToken(t.mint, t.sym);
    }
  }
}

async function main() {
  console.log(`=========================================================`);
  console.log(`🔬 BUNDLER RESEARCH WORKER (POLLING SETIAP 5 DETIK)`);
  console.log(`   Menjawab Pertanyaan: "Apakah Bundler Terus Meningkat?"`);
  console.log(`   Data Disimpan Di  : data/research-bundler-timeseries.jsonl`);
  console.log(`   Ringkasan Di      : data/research-bundler-summary.json`);
  console.log(`=========================================================\n`);

  const worker = new BundlerResearchWorker();
  
  // Daftarkan token aktif yang sudah ada
  worker.registerRecentTokens();
  
  // Dengarkan token baru dari live WebSocket stream journalctl
  worker.startLogTailListener();
  
  // Jalankan interval polling 5 detik
  worker.startPollingLoop();
}

main().catch(console.error);
