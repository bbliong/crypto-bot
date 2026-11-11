import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const dataDir = join(__dirname, '../data');

export function render3ScenariosLiveHtml() {
  const liveFile = join(dataDir, 'dryrun-3scenarios-live.json');
  let data = { s4: null, s6: null };
  if (existsSync(liveFile)) {
    try {
      data = JSON.parse(readFileSync(liveFile, 'utf8'));
    } catch {}
  }

  const settingsFile = join(dataDir, 'follower-autobuy-settings.json');
  let autobuyConfig = { enabled: false, autobuyScenario: 'OFF' };
  if (existsSync(settingsFile)) {
    try {
      autobuyConfig = JSON.parse(readFileSync(settingsFile, 'utf8'));
    } catch {}
  }

  const devStateFile = join(dataDir, 'follower-dev-watcher-state.json');
  let devWatcherState = { active: false, target: null };
  if (existsSync(devStateFile)) {
    try {
      devWatcherState = JSON.parse(readFileSync(devStateFile, 'utf8'));
    } catch {}
  }
  const isAutoBuyEnabled = Boolean(autobuyConfig.enabled);
  let activeScenario = String(autobuyConfig.autobuyScenario || (isAutoBuyEnabled ? 'BOTH' : 'OFF')).toUpperCase();
  if (!isAutoBuyEnabled && activeScenario !== 'DRY_RUN') activeScenario = 'OFF';

  const isS4Real = activeScenario === 'S4' || activeScenario === 'BOTH';
  const isS5Real = activeScenario === 'S5' || activeScenario === 'BOTH';
  const isS6Real = activeScenario === 'S6' || activeScenario === 'BOTH';
  const isS7Real = activeScenario === 'S7' || activeScenario === 'BOTH';
  const isS8Real = activeScenario === 'S8' || activeScenario === 'BOTH';
  const isS9Real = activeScenario === 'S9' || activeScenario === 'BOTH';
  const isS95Real = activeScenario === 'S95' || activeScenario === 'S9_5' || activeScenario === 'BOTH';
  const isS10Real = activeScenario === 'S10' || activeScenario === 'BOTH';
  const isS13Real = activeScenario === 'S13' || activeScenario === 'BOTH';
  const isS135Real = activeScenario === 'S13_5' || activeScenario === 'S135' || activeScenario === 'S14' || activeScenario === 'BOTH';
  const isDryRun = activeScenario === 'DRY_RUN';

  const s4Stake = Number(autobuyConfig.stakeUsdS4) || 1.0;
  const s5Stake = Number(autobuyConfig.stakeUsdS5) || 1.0;
  const s6Pool1 = Number(autobuyConfig.stakeUsdS6Pool1) || 1.0;
  const s6Pool2 = Number(autobuyConfig.stakeUsdS6Pool2) || 1.0;
  const s7Pool1 = Number(autobuyConfig.stakeUsdS7Pool1) || 1.0;
  const s7Pool2 = Number(autobuyConfig.stakeUsdS7Pool2) || 1.0;
  const s8Stake = Number(autobuyConfig.stakeUsdS8) || 1.0;
  const s9Stake = Number(autobuyConfig.stakeUsdS9) || 1.0;
  const s95Stake = Number(autobuyConfig.stakeUsdS95) || Number(autobuyConfig.stakeUsdS9) || 0.25;
  const s10Stake = Number(autobuyConfig.stakeUsdS10) || 0.25;
  const s13Stake = Number(autobuyConfig.stakeUsdS13) || 5.0;
  const s135Stake = Number(autobuyConfig.stakeUsdS13_5) || Number(autobuyConfig.stakeUsdS13) || 5.0;

  const s4 = data.s4 || { name: `Skenario 4: 2-Lapis Shakeout Trap (Hold 8s & Dump on Buyback)`, description: `Saldo Awal $5.00. Modal $${s4Stake.toFixed(2)}. Jika target sell <= 3s (shakeout): tahan hingga 8 detik. Begitu target buyback: LANGSUNG SELL 100% dump ke likuiditas target. Jika tidak buyback dlm 8s -> Safety Exit.`, availableCash: 5.0, investedCash: 0, realizedPnl: 0, wins: 0, losses: 0, totalTrades: 0, openPositions: [], closedTrades: [], recentEvents: [] };
  const s5 = data.s5 || { name: `Skenario 5: Anti-Shakeout Runner (TP +25% | Hold >= 12s | Time-Stop 35s)`, description: 'Saldo Awal $5.00. Modal $1.00. Abaikan goyangan dump target di 12 detik pertama (Anti-Shakeout). Auto Take-Profit +25%, Time-Stop 35s, atau ikuti sell target jika dump pasca detik 12.', availableCash: 5.0, investedCash: 0, realizedPnl: 0, wins: 0, losses: 0, totalTrades: 0, openPositions: [], closedTrades: [], recentEvents: [] };
  const s6 = data.s6 || { name: 'Skenario 6: Re-Deploy Sniper V2 (Split TP 50/50: 5% & 15%)', availableCash: 5.0, investedCash: 0, realizedPnl: 0, wins: 0, losses: 0, totalTrades: 0, openPositions: [], closedTrades: [], recentEvents: [] };
  const s7 = data.s7 || { name: 'Skenario 7: Time-Stop Sniper (Stage 1 @ 5% + Force Sell @ 28s)', description: 'Saldo Awal $5.00. Entry First Buy Ground Zero. Stage 1: TP 50% di >= 5% Anti-Rug. Stage 2: Kejar >= 15% ATAU Force Sell 100% tepat di Detik 28 (Puncak Pump) sebelum dev rugpull.', availableCash: 5.0, investedCash: 0, realizedPnl: 0, wins: 0, losses: 0, totalTrades: 0, openPositions: [], closedTrades: [], recentEvents: [] };
  const s8 = data.s8 || { name: 'Skenario 8: Front-Run Dev & Dump on Target Entry', description: 'Saldo Awal $5.00. Buy instan di Detik 0 saat Dev rilis pool baru. Begitu Target masuk beli (15-20 SOL), bot LANGSUNG SELL 100% dump ke likuiditas target!', availableCash: 5.0, investedCash: 0, realizedPnl: 0, wins: 0, losses: 0, totalTrades: 0, openPositions: [], closedTrades: [], recentEvents: [] };
  const s9 = data.s9 || { name: 'Skenario 9: Dev Front-Run & 2-Way Target Sync (Max 60s Timeout)', description: 'Saldo Awal $5.00. Modal $1.00. Proaktif Buy di Detik 0 saat Dev rilis pool baru sebelum target whale masuk. Jika target tidak masuk dalam 60s -> Force Sell. Komparasi 2-arah jika target beralih dev.', availableCash: 5.0, investedCash: 0, realizedPnl: 0, wins: 0, losses: 0, totalTrades: 0, openPositions: [], closedTrades: [], recentEvents: [] };
  const s9_5 = data.s9_5 || { name: 'Skenario 9.5: Split TP 50/50 + 1-Min Moonbag (TP 50% @ >=300% & 50% Hold 1m / Dump on Whale Exit)', description: 'Saldo Awal $5.00. Modal $0.25 (sama seperti S9). Masuk Detik-0 dari sinyal Dev. Jika gain >= +300% (lonjakan awal swap): JUAL 50% untuk amankan profit masif, sisa 50% DITAHAN selama 1 menit (Moonbag). Jika target whale dump 100%, LANGSUNG JUAL SEMUA seketika. Jika gain < 300%: TP normal di +25%.', availableCash: 5.0, investedCash: 0, realizedPnl: 0, wins: 0, losses: 0, totalTrades: 0, openPositions: [], closedTrades: [], recentEvents: [] };
  const s10 = data.s10 || { name: 'Skenario 10: Dynamic Wave Runner (Genesis Buy + MCap/Whale Sell Sync)', description: 'Saldo Awal $5.00. Modal $0.25. Proaktif Buy di Detik 0 saat Dev rilis pool baru. Tidak buru-buru TP kaku 25% jika whale masih hold koin. Begitu whale mulai dump >= 15% atau time-stop 30s pasca-inflow: LANGSUNG SELL 100% di puncak wave!', availableCash: 5.0, investedCash: 0, realizedPnl: 0, wins: 0, losses: 0, totalTrades: 0, openPositions: [], closedTrades: [], recentEvents: [] };
  const s13 = data.s13 || { name: 'Skenario 13: Multi-Cycle Ping-Pong Scalper (Post-Whale Dip & Buyback Harvester)', description: 'Saldo Awal $5.00. Modal $5.00/entry (Maks 10x Siklus). MASUK SETELAH WHALE MASUK. Syarat: Whale masuk >= 20 SOL & usia koin < 15m. Beli saat Whale SELL (tampung harga diskon). Jual saat TP +10% atau Whale BUYBACK (+5%). Cut-loss -10%. Stop jika Whale dump >= 40%.', availableCash: 5.0, investedCash: 0, realizedPnl: 0, wins: 0, losses: 0, totalTrades: 0, openPositions: [], closedTrades: [], recentEvents: [] };
  const s13_5 = data.s13_5 || { name: 'Skenario 13.5: Adaptive Ping-Pong Runner (Uncapped Cycles | 3 Consecutive Sells & Dynamic Health Gates)', description: 'Saldo Awal $5.00. Modal $5.00/entry (Tanpa Batas 10 Siklus). MASUK SETELAH WHALE MASUK (Inflow >= 20 SOL). Beli di lembah Sell #1 (Normal Dip). Bekukan beli jika Sell beruntun >= 2x. Jual di TP +10% atau Whale BUYBACK. Rem Darurat: jika Whale sell 3x beruntun tanpa buyback, kumulatif dump >= 35%, sell tunggal >= $300, atau usia koin >= 10m.', availableCash: 5.0, investedCash: 0, realizedPnl: 0, wins: 0, losses: 0, totalTrades: 0, openPositions: [], closedTrades: [], recentEvents: [] };
  const s13_alpha = data.s13_alpha || { name: 'Skenario 13-Alpha: 1-Second Sniper Gate (Pre-Entry 1s Verification | Target TP +100% Full Exit)', description: 'Saldo Awal $5.00. Modal $5.00/entry (1x Entry, Tanpa Ping-Pong). Detik 0: Whale masuk (>= 20 SOL), Alpha pasang delay observasi 1.000 ms. Jika dalam 1s terdeteksi >= 3 sniper sells (indikator kolam rugpull), ABORT BUY (kebal rugpull 100%, $0 fee). Jika dalam 1s sniper sell <= 2 (akumulasi murni koin pemenang), eksekusi BUY di detik 1. Target Take Profit +100% (2x Lipat Modal) lalu LANGSUNG SELL SEMUA. Stop Loss -10% / Whale Dump.', availableCash: 5.0, investedCash: 0, realizedPnl: 0, wins: 0, losses: 0, totalTrades: 0, openPositions: [], closedTrades: [], recentEvents: [] };
  const s13_beta = data.s13_beta || { name: 'Skenario 13-Beta: Instant Buy + 1.5s Panic Cut (Post-Entry Rescue | Target TP +100% Full Exit)', description: 'Saldo Awal $5.00. Modal $5.00/entry (1x Entry, Tanpa Ping-Pong). Detik 0: Langsung BUY bersama Whale. Selama 1.5 detik pertama (1500 ms), pasang radar deteksi sniper sell. Jika terdeteksi >= 2 sniper sell, LANGSUNG JUAL DI DETIK ITU JUGA (Instant Emergency Dump), mengamankan modal sebelum Dev RemoveLiquidity di detik 5. Jika aman, tahan posisi hingga Take Profit +100% (2x Lipat Modal) lalu LANGSUNG SELL SEMUA. Stop Loss -10% / Whale Dump.', availableCash: 5.0, investedCash: 0, realizedPnl: 0, wins: 0, losses: 0, totalTrades: 0, openPositions: [], closedTrades: [], recentEvents: [] };
  const s13_alpha_1 = data.s13_alpha_1 || { name: 'Skenario 13-Alpha-1: 1s Sniper Gate + Whale Wave Rider (Max Profit on Whale Sell Signals)', description: 'Saldo Awal $5.00. Modal $5.00/entry (1x Ride). Detik 0: Whale masuk >= 20 SOL, Alpha-1 verifikasi 1s on-chain. Jika ada >= 3 sniper sell atau >= 12 txs -> ABORT (100% Kebal Rugpull). Jika aman, BUY di detik 1. TAHAN SELAMA WHALE PING-PONG! Exit HANYA jika: (1) Whale sell 3x beruntun tanpa buyback, (2) Whale sell tunggal >= 2.5 SOL, (3) Trailing stop -20% dari peak setelah gain >= +100%, atau (4) Stop loss -10% / Max age 10m.', availableCash: 5.0, investedCash: 0, realizedPnl: 0, wins: 0, losses: 0, totalTrades: 0, openPositions: [], closedTrades: [], recentEvents: [] };
  const s13_beta_1 = data.s13_beta_1 || { name: 'Skenario 13-Beta-1: Instant Buy + 1.5s Rescue + Whale Wave Rider (Max Profit on Whale Sell Signals)', description: 'Saldo Awal $5.00. Modal $5.00/entry (1x Ride). Detik 0: Langsung BUY bersama Whale. Jika dalam 1.5s terdeteksi >= 2 sniper sell atau >= 12 on-chain txs -> Instant Emergency Dump selamatkan modal. Jika aman, TAHAN SELAMA WHALE PING-PONG! Exit HANYA jika: (1) Whale sell 3x beruntun tanpa buyback, (2) Whale sell tunggal >= 2.5 SOL, (3) Trailing stop -20% dari peak setelah gain >= +100%, atau (4) Stop loss -10% / Max age 10m.', availableCash: 5.0, investedCash: 0, realizedPnl: 0, wins: 0, losses: 0, totalTrades: 0, openPositions: [], closedTrades: [], recentEvents: [] };
  const s13_centaur = data.s13_centaur || { name: 'Skenario 13-Centaur: Hybrid Initial Pump Rider & 25s Whale Decision Gate', description: 'Saldo Awal $5.00. Modal $5.00/entry. Detik 0: Masuk bersama Whale (>= 20 SOL). Detik 0-20: Tahan posisi (Guaranteed Pump +60% - +100%). Detik 20-25 (Decision Gate): Evaluasi aksi Whale. JALUR A (Rugpull Trap): Jika Whale pasif (0 buyback) atau ada sell >= 8 SOL, LANGSUNG EXIT di detik 20-25 (kunci cuan +40% - +80% sebelum bom banting). JALUR B (Runner Sejati): Jika Whale aktif ping-pong (buyback >= 1x, sell < 8 SOL), SWITCH KE WAVE RIDER MODE (tahan hingga trailing stop -20% pasca +100%, whale exhaustion 3x sell, atau timeout 30m).', availableCash: 5.0, investedCash: 0, realizedPnl: 0, wins: 0, losses: 0, totalTrades: 0, openPositions: [], closedTrades: [], recentEvents: [] };
  const s14 = data.s14 || { name: 'Skenario 14: Bundler-Confirmed Runner (Wave Rider)', description: 'Saldo Awal $5.00. Modal $5.00/entry. Standby saat Detik 0 (menghindari rugpull kilat & shakeout trap). Menunggu konfirmasi on-chain Bundler Rate >= 5.0% dan Whale terbukti aktif buyback/ping-pong. Begitu terkonfirmasi runner: BUY $5.00. Take Profit Bertahap: Jual 50% di +50% gain (amankan modal), sisa 50% moonbag ditahan hingga +100% atau Whale Dump. Stop Loss -20% dari entry (sebelum TP 1). Whale consecutive sells hanya hitung order signifikan >= 3 SOL atau holding < 50% (anti-shakeout). Giant Dump >= 15 SOL exit 100%.', availableCash: 5.0, investedCash: 0, realizedPnl: 0, wins: 0, losses: 0, totalTrades: 0, openPositions: [], closedTrades: [], recentEvents: [] };
  const s14_alpha = data.s14_alpha || { name: 'Skenario 14-Alpha: Bundler Runner + 60s Grace Period (Anti-Rugpull 100%)', description: 'Saldo Awal $5.00. Modal $5.00/entry. Grace Period Umur Token >= 60 detik (kebal total rugpull kilat Dev). Menunggu konfirmasi on-chain Bundler Rate >= 5.0% dan Whale terbukti aktif buyback/ping-pong. Begitu terkonfirmasi runner: BUY $5.00. Take Profit Bertahap: Jual 50% di +50% gain (amankan modal), sisa 50% moonbag ditahan hingga +100% atau Whale Dump. Stop Loss -20% dari entry (sebelum TP 1). Anti-shakeout sell >= 3 SOL. Giant Dump >= 15 SOL exit 100%.', availableCash: 5.0, investedCash: 0, realizedPnl: 0, wins: 0, losses: 0, totalTrades: 0, openPositions: [], closedTrades: [], recentEvents: [] };
  const s14_beta = data.s14_beta || { name: 'Skenario 14-Beta: Bundler Runner + 60s Grace + Whale Hoarding Trap Defense', description: 'Saldo Awal $5.00. Modal $5.00/entry. Grace Period Umur Token >= 60 detik (kebal total rugpull kilat Dev). Menunggu konfirmasi on-chain Bundler Rate >= 5.0% dan Whale terbukti aktif buyback/ping-pong. Begitu terkonfirmasi runner: BUY $5.00. Take Profit Bertahap: Jual 50% di +50% gain (amankan modal), sisa 50% moonbag ditahan hingga +100% atau Whale Dump. Whale Hoarding Trap Defense: Jika pasca-buy bag Whale membengkak >= +25% dari saldo awal entry atau > 8.0% supply (> 80M token) akibat menelan barang sendiri -> LANGSUNG FULL EXIT 100% SEKETIKA (amankan cuan sebelum Dev drain LP). Stop Loss -20% dari entry.', availableCash: 5.0, investedCash: 0, realizedPnl: 0, wins: 0, losses: 0, totalTrades: 0, openPositions: [], closedTrades: [], recentEvents: [] };

  function renderScenarioCard(s, color, scId = 'sce4') {
    const isPnlPositive = s.realizedPnl >= 0;
    const pnlSign = isPnlPositive ? '+' : '';
    const pnlClass = isPnlPositive ? 'val-emerald' : 'val-rose';
    const winRate = s.totalTrades > 0 ? ((s.wins / s.totalTrades) * 100).toFixed(1) : '0';
    const isRealActive = scId === 'sce4' ? isS4Real : (scId === 'sce5' ? isS5Real : (scId === 'sce6' ? isS6Real : (scId === 'sce7' ? isS7Real : (scId === 'sce8' ? isS8Real : (scId === 'sce9' ? isS9Real : (scId === 'sce9_5' ? isS95Real : (scId === 'sce10' ? isS10Real : (scId === 'sce13' ? isS13Real : isS135Real))))))));

    return `
      <div class="scenario-panel" style="border-top: 4px solid ${color};">
        <div class="panel-header">
          <div style="display:flex; justify-content:space-between; align-items:flex-start; gap:8px;">
            <div class="panel-title">${s.name}</div>
            <span style="font-size:0.68rem; padding: 2px 8px; border-radius: 4px; font-weight:800; white-space:nowrap; ${isRealActive ? 'background:rgba(16,185,129,0.2); color:#10b981; border:1px solid rgba(16,185,129,0.4);' : (isDryRun ? 'background:rgba(56,189,248,0.2); color:#38bdf8; border:1px solid rgba(56,189,248,0.5);' : 'background:rgba(148,163,184,0.15); color:#94a3b8; border:1px solid #334155;')}">
              ${isRealActive ? '⚡ REAL AUTO-BUY' : (isDryRun ? '⚪ DRY RUN REALISTIS' : '⚪ SIMULASI SWAP')}
            </span>
          </div>
          <div class="panel-desc">${s.description || ''}</div>
        </div>

        <div class="stat-mini-grid">
          <div class="mini-stat">
            <div class="mini-label">Kas Tersedia (Dinamis)</div>
            <div class="mini-val" style="color:${color};">$${s.availableCash.toFixed(2)}</div>
            <div class="mini-sub">Fee Dipotong: -$${(s.totalFeesPaid || 0).toFixed(2)}</div>
          </div>
          <div class="mini-stat">
            <div class="mini-label">Realized PnL</div>
            <div class="mini-val ${pnlClass}">${pnlSign}$${s.realizedPnl.toFixed(2)}</div>
            <div class="mini-sub">${s.wins}W / ${s.losses}L (${winRate}%)</div>
          </div>
          <div class="mini-stat">
            <div class="mini-label">Total Portfolio</div>
            <div class="mini-val">$${s.totalPortfolioValue ? s.totalPortfolioValue.toFixed(2) : (s.availableCash + s.investedCash).toFixed(2)}</div>
            <div class="mini-sub">Modal Awal $20.00</div>
          </div>
        </div>

        <!-- Stake Configuration Section -->
        ${scId === 'sce4' ? `
          <div class="stake-card-section">
            <div class="stake-section-header">
              <span class="stake-section-title">⚙️ Konfigurasi Modal Buy (1 Input)</span>
              <span class="stake-current-val">Aktif: $${s4Stake.toFixed(2)}</span>
            </div>
            <div class="stake-form-row">
              <div class="stake-input-wrap">
                <span class="currency-prefix">$</span>
                <input type="number" id="s4StakeInput" value="${s4Stake.toFixed(2)}" step="0.05" min="0.05" max="1000" placeholder="0.25">
              </div>
              <button onclick="saveS4Stake()" class="btn-stake-save">💾 Simpan Modal S4</button>
            </div>
          </div>
        ` : (scId === 'sce5' ? `
          <div class="stake-card-section">
            <div class="stake-section-header">
              <span class="stake-section-title">⚙️ Konfigurasi Modal S5 (Anti-Shakeout)</span>
              <span class="stake-current-val">Aktif: $${s5Stake.toFixed(2)}</span>
            </div>
            <div class="stake-form-row">
              <div class="stake-input-wrap">
                <span class="currency-prefix">$</span>
                <input type="number" id="s5StakeInput" value="${s5Stake.toFixed(2)}" step="0.05" min="0.05" max="1000" placeholder="1.00">
              </div>
              <button onclick="saveS5Stake()" class="btn-stake-save">💾 Simpan Modal S5</button>
            </div>
          </div>
        ` : (scId === 'sce6' ? `
          <div class="stake-card-section">
            <div class="stake-section-header">
              <span class="stake-section-title">⚙️ Konfigurasi Modal S6 (2 Pool)</span>
              <span class="stake-current-val">P1: $${s6Pool1.toFixed(2)} | P2: $${s6Pool2.toFixed(2)}</span>
            </div>
            <div class="stake-form-grid-2">
              <div>
                <label class="stake-sublabel">Pool 1 (Koin Baru):</label>
                <div class="stake-input-wrap">
                  <span class="currency-prefix">$</span>
                  <input type="number" id="s6Pool1Input" value="${s6Pool1.toFixed(2)}" step="0.05" min="0.05" max="1000" placeholder="5.00">
                </div>
              </div>
              <div>
                <label class="stake-sublabel">Pool 2+ (Re-Deploy):</label>
                <div class="stake-input-wrap">
                  <span class="currency-prefix">$</span>
                  <input type="number" id="s6Pool2Input" value="${s6Pool2.toFixed(2)}" step="0.05" min="0.05" max="1000" placeholder="7.00">
                </div>
              </div>
            </div>
            <button onclick="saveS6Stake()" class="btn-stake-save" style="margin-top: 4px; width: 100%;">💾 Simpan Modal S6 (Pool 1 & 2)</button>
          </div>
        ` : (scId === 'sce7' ? `
          <div class="stake-card-section">
            <div class="stake-section-header">
              <span class="stake-section-title">⚙️ Konfigurasi Modal S7 (2 Pool)</span>
              <span class="stake-current-val">P1: $${s7Pool1.toFixed(2)} | P2: $${s7Pool2.toFixed(2)}</span>
            </div>
            <div class="stake-form-grid-2">
              <div>
                <label class="stake-sublabel">Pool 1 (Koin Baru):</label>
                <div class="stake-input-wrap">
                  <span class="currency-prefix">$</span>
                  <input type="number" id="s7Pool1Input" value="${s7Pool1.toFixed(2)}" step="0.05" min="0.05" max="1000" placeholder="1.00">
                </div>
              </div>
              <div>
                <label class="stake-sublabel">Pool 2+ (Re-Deploy):</label>
                <div class="stake-input-wrap">
                  <span class="currency-prefix">$</span>
                  <input type="number" id="s7Pool2Input" value="${s7Pool2.toFixed(2)}" step="0.05" min="0.05" max="1000" placeholder="2.00">
                </div>
              </div>
            </div>
            <button onclick="saveS7Stake()" class="btn-stake-save" style="margin-top: 4px; width: 100%;">💾 Simpan Modal S7 (Pool 1 & 2)</button>
          </div>
        ` : (scId === 'sce8' ? `
          <div class="stake-card-section">
            <div class="stake-section-header">
              <span class="stake-section-title">⚙️ Konfigurasi Modal S8 (Front-Run Dev)</span>
              <span class="stake-current-val">Stake: $${s8Stake.toFixed(2)}</span>
            </div>
            <div class="stake-form-grid-1" style="margin-top: 6px;">
              <div>
                <label class="stake-sublabel">Modal Entry Genesis:</label>
                <div class="stake-input-wrap">
                  <span class="currency-prefix">$</span>
                  <input type="number" id="s8StakeInput" value="${s8Stake.toFixed(2)}" step="0.05" min="0.05" max="1000" placeholder="1.00">
                </div>
              </div>
            </div>
            <button onclick="saveS8Stake()" class="btn-stake-save" style="margin-top: 6px; width: 100%;">💾 Simpan Modal S8</button>
          </div>
        ` : (scId === 'sce9' ? `
          <div class="stake-card-section">
            <div class="stake-section-header">
              <span class="stake-section-title">⚙️ Konfigurasi Modal S9 (Dev Front-Run Sync)</span>
              <span class="stake-current-val">Stake: $${s9Stake.toFixed(2)}</span>
            </div>
            <div class="stake-form-grid-1" style="margin-top: 6px;">
              <div>
                <label class="stake-sublabel">Modal Entry Genesis:</label>
                <div class="stake-input-wrap">
                  <span class="currency-prefix">$</span>
                  <input type="number" id="s9StakeInput" value="${s9Stake.toFixed(2)}" step="0.05" min="0.05" max="1000" placeholder="1.00">
                </div>
              </div>
            </div>
            <button onclick="saveS9Stake()" class="btn-stake-save" style="margin-top: 6px; width: 100%;">💾 Simpan Modal S9</button>
          </div>
        ` : `
          <div class="stake-card-section">
            <div class="stake-section-header">
              <span class="stake-section-title">⚙️ Konfigurasi Modal S10 (Dynamic Wave Runner)</span>
              <span class="stake-current-val">Stake: $${s10Stake.toFixed(2)}</span>
            </div>
            <div class="stake-form-grid-1" style="margin-top: 6px;">
              <div>
                <label class="stake-sublabel">Modal Entry Genesis:</label>
                <div class="stake-input-wrap">
                  <span class="currency-prefix">$</span>
                  <input type="number" id="s10StakeInput" value="${s10Stake.toFixed(2)}" step="0.05" min="0.05" max="1000" placeholder="0.25">
                </div>
              </div>
            </div>
            <button onclick="saveS10Stake()" class="btn-stake-save" style="margin-top: 6px; width: 100%;">💾 Simpan Modal S10</button>
          </div>
        `)))))}

        <!-- Open Positions -->
        <div class="sub-section">
          <h5>🟡 Posisi Sedang Berjalan (${s.openPositions.length})</h5>
          ${s.openPositions.length === 0 ? '<div class="empty-hint">Tidak ada posisi terbuka (Kas bebas)</div>' : `
            <table class="pos-table">
              <thead><tr><th>Token</th><th>Entry</th><th>Basis $</th><th>Koin</th><th>Floating PnL</th></tr></thead>
              <tbody>
                ${s.openPositions.map(p => {
                  const pPnl = p.unrealizedPnlUsd >= 0 ? '+' : '';
                  const cClass = p.unrealizedPnlUsd >= 0 ? 'val-emerald' : 'val-rose';
                  return `
                    <tr>
                      <td><strong>${p.symbol}</strong></td>
                      <td>${p.entryCount}x Buy</td>
                      <td class="mono">$${p.costBasisUsd.toFixed(2)}</td>
                      <td class="mono">${p.tokens.toLocaleString()}</td>
                      <td class="mono ${cClass}">${pPnl}$${p.unrealizedPnlUsd.toFixed(2)}</td>
                    </tr>
                  `;
                }).join('')}
              </tbody>
            </table>
          `}
        </div>

        <!-- Recent Logs -->
        <div class="sub-section">
          <h5>📜 5 Aktivitas Terakhir</h5>
          ${s.recentEvents.slice(0, 5).map(ev => {
            const actColor = ev.action === 'BUY' ? 'var(--emerald)' : (ev.action === 'SELL' ? 'var(--cyan)' : '#94a3b8');
            const isTargetSkipped = ev.reason && (ev.reason.includes('TARGET_SKIPPED') || ev.reason.includes('S8_NO_TARGET_ENTRY'));
            const isTargetInflow = ev.reason && ev.reason.includes('TARGET_BUY_INFLOW');
            return `
              <div class="event-row">
                <span style="color:${actColor}; font-weight:700;">${ev.action} ${ev.symbol}</span>
                <span class="mono" style="font-size:0.75rem; color:#cbd5e1;">
                  ${ev.stakeUsd ? `$${ev.stakeUsd.toFixed(2)}` : (ev.usdReceived ? `+$${ev.usdReceived.toFixed(2)}` : '')}
                </span>
                ${isTargetSkipped ? '<span style="font-size:0.62rem; background:rgba(239,68,68,0.2); color:#f87171; border:1px solid rgba(239,68,68,0.4); padding:1px 5px; border-radius:4px; font-weight:700;">⚠️ TARGET SKIP</span>' : ''}
                ${isTargetInflow ? '<span style="font-size:0.62rem; background:rgba(16,185,129,0.2); color:#34d399; border:1px solid rgba(16,185,129,0.4); padding:1px 5px; border-radius:4px; font-weight:700;">🎯 TARGET INFLOW</span>' : ''}
                <span style="font-size:0.7rem; color:#64748b;">${ev.timeWib ? ev.timeWib.slice(11, 19) : ''}</span>
              </div>
            `;
          }).join('')}
        </div>

        <!-- Button to Timeline Page -->
        <a href="/add-fol/3scenarios/${scId}" class="nav-btn" style="width: 100%; justify-content: center; margin-top: 10px; background: rgba(129, 140, 248, 0.15); color: #a5b4fc; border: 1px solid rgba(129, 140, 248, 0.4); text-decoration: none; font-size: 0.82rem; font-weight: 700;">
          🔍 Lihat Detail Transaksi & Timeline API (${scId.toUpperCase()}) ↗
        </a>
      </div>
    `;
  }

  return `<!DOCTYPE html>
<html lang="id">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Live Dry-Run 2 Skenario (S4 vs S6) | cr.bbliong.io</title>
  <style>
    :root {
      --bg-dark: #090d16;
      --bg-panel: #0f172a;
      --card-bg: #141e33;
      --card-border: #1e293b;
      --primary: #818cf8;
      --emerald: #10b981;
      --rose: #f43f5e;
      --amber: #f59e0b;
      --cyan: #06b6d4;
      --purple: #a855f7;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      background: var(--bg-dark);
      color: #f1f5f9;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      padding: 24px 16px;
      line-height: 1.5;
    }
    .container { max-width: 1600px; margin: 0 auto; }
    .header {
      display: flex;
      flex-wrap: wrap;
      justify-content: space-between;
      align-items: center;
      gap: 16px;
      margin-bottom: 24px;
      padding-bottom: 16px;
      border-bottom: 1px solid var(--card-border);
    }
    .header-title h1 {
      font-size: 1.6rem;
      font-weight: 700;
      background: linear-gradient(135deg, #a5b4fc, #38bdf8, #f472b6, #fbbf24);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
      display: flex;
      align-items: center;
      gap: 10px;
    }
    .header-subtitle { color: #94a3b8; font-size: 0.9rem; margin-top: 4px; }
    .nav-group { display: flex; gap: 8px; flex-wrap: wrap; }
    .nav-btn {
      display: inline-flex; align-items: center; gap: 6px;
      background: #1e293b; color: #cbd5e1; padding: 8px 14px;
      border-radius: 8px; text-decoration: none; font-size: 0.82rem;
      font-weight: 600; border: 1px solid #334155; transition: all 0.2s;
    }
    .nav-btn:hover { background: #334155; color: #fff; }
    .nav-btn.active { background: var(--primary); color: #fff; border-color: var(--primary); }

    .live-badge {
      display: inline-flex; align-items: center; gap: 6px;
      background: rgba(16, 185, 129, 0.15); color: var(--emerald);
      border: 1px solid rgba(16, 185, 129, 0.4);
      padding: 4px 10px; border-radius: 20px; font-size: 0.75rem; font-weight: 700;
    }
    .live-dot {
      width: 8px; height: 8px; border-radius: 50%; background: var(--emerald);
      box-shadow: 0 0 8px var(--emerald); animation: pulse 1.5s infinite;
    }
    @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.4; } }

    /* 5 Scenarios Grid */
    .scenarios-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(310px, 1fr));
      gap: 16px;
      margin-bottom: 24px;
    }
    .scenario-panel {
      background: var(--bg-panel);
      border: 1px solid var(--card-border);
      border-radius: 12px;
      padding: 20px;
      display: flex;
      flex-direction: column;
      gap: 16px;
    }
    .panel-header { border-bottom: 1px solid #1e293b; padding-bottom: 10px; }
    .panel-title { font-size: 1.05rem; font-weight: 700; color: #f8fafc; }
    .panel-desc { font-size: 0.8rem; color: #94a3b8; margin-top: 4px; }

    .stat-mini-grid {
      display: grid;
      grid-template-columns: repeat(3, 1fr);
      gap: 8px;
    }
    .mini-stat {
      background: #0f172a;
      border: 1px solid #1e293b;
      border-radius: 8px;
      padding: 10px;
    }
    .mini-label { font-size: 0.68rem; color: #94a3b8; text-transform: uppercase; }
    .mini-val { font-size: 1.15rem; font-weight: 700; margin-top: 2px; }
    .mini-sub { font-size: 0.68rem; color: #64748b; margin-top: 2px; }

    .val-emerald { color: var(--emerald); }
    .val-rose { color: var(--rose); }
    .mono { font-family: ui-monospace, monospace; }

    .sub-section h5 { font-size: 0.82rem; color: #cbd5e1; margin-bottom: 8px; text-transform: uppercase; letter-spacing: 0.05em; }
    .empty-hint { font-size: 0.8rem; color: #64748b; font-style: italic; padding: 6px 0; }

    .pos-table { width: 100%; border-collapse: collapse; font-size: 0.78rem; }
    .pos-table th { background: #1e293b; color: #94a3b8; padding: 4px 8px; text-align: left; }
    .pos-table td { padding: 6px 8px; border-bottom: 1px solid rgba(30, 41, 59, 0.5); }

    .event-row {
      display: flex; justify-content: space-between; align-items: center;
      padding: 6px 0; border-bottom: 1px dashed rgba(30, 41, 59, 0.4); font-size: 0.8rem;
    }
    .event-row:last-child { border-bottom: none; }

    /* Stake Config Box in Scenario Panel */
    .stake-card-section {
      background: #0b1120;
      border: 1px solid #1e293b;
      border-radius: 8px;
      padding: 12px 14px;
      display: flex;
      flex-direction: column;
      gap: 8px;
    }
    .stake-section-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      font-size: 0.74rem;
    }
    .stake-section-title {
      font-weight: 700;
      color: #cbd5e1;
      text-transform: uppercase;
      letter-spacing: 0.04em;
    }
    .stake-current-val {
      font-weight: 700;
      color: var(--primary);
      font-family: ui-monospace, monospace;
    }
    .stake-form-row {
      display: flex;
      gap: 8px;
      align-items: center;
    }
    .stake-form-grid-2 {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 10px;
    }
    .stake-sublabel {
      font-size: 0.7rem;
      color: #94a3b8;
      display: block;
      margin-bottom: 3px;
    }
    .stake-input-wrap {
      position: relative;
      display: flex;
      align-items: center;
      flex: 1;
    }
    .currency-prefix {
      position: absolute;
      left: 10px;
      color: #94a3b8;
      font-weight: 700;
      font-size: 0.85rem;
      pointer-events: none;
    }
    .stake-input-wrap input {
      width: 100%;
      background: #141e33;
      border: 1px solid #334155;
      color: #f8fafc;
      padding: 6px 10px 6px 24px;
      border-radius: 6px;
      font-size: 0.88rem;
      font-weight: 700;
      font-family: ui-monospace, monospace;
      outline: none;
      transition: border-color 0.2s;
    }
    .stake-input-wrap input:focus {
      border-color: var(--primary);
    }
    .btn-stake-save {
      background: #1e293b;
      color: #f8fafc;
      border: 1px solid #475569;
      border-radius: 6px;
      padding: 6px 12px;
      font-size: 0.76rem;
      font-weight: 700;
      cursor: pointer;
      transition: all 0.2s;
      white-space: nowrap;
    }
    .btn-stake-save:hover {
      background: #334155;
      border-color: #64748b;
      color: #fff;
    }

    /* Autobuy Bar & Scenario Selector */
    .autobuy-bar {
      display: flex;
      flex-direction: column;
      background: #141e33;
      border: 1px solid #334155;
      border-radius: 14px;
      padding: 18px 22px;
      margin-bottom: 24px;
      gap: 16px;
      box-shadow: 0 4px 20px rgba(0, 0, 0, 0.25);
    }
    .autobuy-top {
      display: flex;
      flex-wrap: wrap;
      justify-content: space-between;
      align-items: center;
      gap: 12px;
      border-bottom: 1px solid rgba(255, 255, 255, 0.08);
      padding-bottom: 12px;
    }
    .autobuy-title {
      font-weight: 700;
      font-size: 0.98rem;
      color: #f8fafc;
      display: flex;
      align-items: center;
      gap: 10px;
    }
    .autobuy-sub {
      font-size: 0.84rem;
      color: #cbd5e1;
      line-height: 1.45;
    }

    .status-pill {
      font-size: 0.72rem;
      padding: 3px 10px;
      border-radius: 6px;
      font-weight: 800;
      letter-spacing: 0.03em;
    }
    .status-off { background: rgba(148, 163, 184, 0.15); color: #94a3b8; border: 1px solid #475569; }
    .status-dry_run, .status-dryrun { background: rgba(56, 189, 248, 0.2); color: #38bdf8; border: 1px solid rgba(56, 189, 248, 0.5); }
    .status-s4 { background: rgba(245, 158, 11, 0.2); color: #f59e0b; border: 1px solid rgba(245, 158, 11, 0.5); }
    .status-s5 { background: rgba(249, 115, 22, 0.2); color: #f97316; border: 1px solid rgba(249, 115, 22, 0.5); }
    .status-s6 { background: rgba(236, 72, 153, 0.2); color: #ec4899; border: 1px solid rgba(236, 72, 153, 0.5); }
    .status-s7 { background: rgba(6, 182, 212, 0.2); color: #06b6d4; border: 1px solid rgba(6, 182, 212, 0.5); }
    .status-s8 { background: rgba(168, 85, 247, 0.2); color: #a855f7; border: 1px solid rgba(168, 85, 247, 0.5); }
    .status-s9 { background: rgba(59, 130, 246, 0.2); color: #3b82f6; border: 1px solid rgba(59, 130, 246, 0.5); }
    .status-s10 { background: rgba(245, 158, 11, 0.2); color: #f59e0b; border: 1px solid rgba(245, 158, 11, 0.5); }
    .status-both { background: rgba(16, 185, 129, 0.2); color: #10b981; border: 1px solid rgba(16, 185, 129, 0.5); }

    .scenario-radio-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
      gap: 10px;
    }
    .scenario-radio-card {
      display: flex;
      align-items: center;
      gap: 12px;
      background: #0f172a;
      border: 1px solid #1e293b;
      border-radius: 10px;
      padding: 12px 14px;
      cursor: pointer;
      transition: all 0.2s;
      user-select: none;
    }
    .scenario-radio-card:hover {
      background: #1e293b;
      border-color: #475569;
    }
    .scenario-radio-card input[type="radio"] {
      appearance: none;
      -webkit-appearance: none;
      width: 18px;
      height: 18px;
      border: 2px solid #64748b;
      border-radius: 50%;
      outline: none;
      cursor: pointer;
      display: grid;
      place-content: center;
      margin: 0;
      flex-shrink: 0;
      transition: all 0.2s;
    }
    .scenario-radio-card input[type="radio"]::before {
      content: "";
      width: 8px;
      height: 8px;
      border-radius: 50%;
      transform: scale(0);
      transition: 120ms transform ease-in-out;
      box-shadow: inset 1em 1em #fff;
    }
    .scenario-radio-card input[type="radio"]:checked::before {
      transform: scale(1);
    }

    .scenario-radio-card.active-off {
      border-color: #64748b;
      background: rgba(148, 163, 184, 0.08);
    }
    .scenario-radio-card.active-off input[type="radio"]:checked {
      border-color: #94a3b8;
      background: #475569;
    }

    .scenario-radio-card.active-dry_run, .scenario-radio-card.active-dryrun {
      border-color: #38bdf8;
      background: rgba(56, 189, 248, 0.12);
      box-shadow: 0 0 12px rgba(56, 189, 248, 0.15);
    }
    .scenario-radio-card.active-dry_run input[type="radio"]:checked, .scenario-radio-card.active-dryrun input[type="radio"]:checked {
      border-color: #38bdf8;
      background: #38bdf8;
    }

    .scenario-radio-card.active-s4 {
      border-color: #f59e0b;
      background: rgba(245, 158, 11, 0.12);
      box-shadow: 0 0 12px rgba(245, 158, 11, 0.15);
    }
    .scenario-radio-card.active-s4 input[type="radio"]:checked {
      border-color: #f59e0b;
      background: #f59e0b;
    }

    .scenario-radio-card.active-s5 {
      border-color: #f97316;
      background: rgba(249, 115, 22, 0.12);
      box-shadow: 0 0 12px rgba(249, 115, 22, 0.15);
    }
    .scenario-radio-card.active-s5 input[type="radio"]:checked {
      border-color: #f97316;
      background: #f97316;
    }

    .scenario-radio-card.active-s6 {
      border-color: #ec4899;
      background: rgba(236, 72, 153, 0.12);
      box-shadow: 0 0 12px rgba(236, 72, 153, 0.15);
    }
    .scenario-radio-card.active-s6 input[type="radio"]:checked {
      border-color: #ec4899;
      background: #ec4899;
    }

    .scenario-radio-card.active-s7 {
      border-color: #06b6d4;
      background: rgba(6, 182, 212, 0.12);
      box-shadow: 0 0 12px rgba(6, 182, 212, 0.15);
    }
    .scenario-radio-card.active-s7 input[type="radio"]:checked {
      border-color: #06b6d4;
      background: #06b6d4;
    }

    .scenario-radio-card.active-s8 {
      border-color: #a855f7;
      background: rgba(168, 85, 247, 0.12);
      box-shadow: 0 0 12px rgba(168, 85, 247, 0.15);
    }
    .scenario-radio-card.active-s8 input[type="radio"]:checked {
      border-color: #a855f7;
      background: #a855f7;
    }

    .scenario-radio-card.active-s9 {
      border-color: #3b82f6;
      background: rgba(59, 130, 246, 0.12);
      box-shadow: 0 0 12px rgba(59, 130, 246, 0.15);
    }
    .scenario-radio-card.active-s9 input[type="radio"]:checked {
      border-color: #3b82f6;
      background: #3b82f6;
    }

    .scenario-radio-card.active-s10 {
      border-color: #f59e0b;
      background: rgba(245, 158, 11, 0.12);
      box-shadow: 0 0 12px rgba(245, 158, 11, 0.15);
    }
    .scenario-radio-card.active-s10 input[type="radio"]:checked {
      border-color: #f59e0b;
      background: #f59e0b;
    }

    .scenario-radio-card.active-both {
      border-color: #10b981;
      background: rgba(16, 185, 129, 0.12);
      box-shadow: 0 0 12px rgba(16, 185, 129, 0.15);
    }
    .scenario-radio-card.active-both input[type="radio"]:checked {
      border-color: #10b981;
      background: #10b981;
    }

    .radio-text {
      display: flex;
      flex-direction: column;
      gap: 2px;
    }
    .radio-main {
      font-size: 0.88rem;
      font-weight: 700;
      color: #f8fafc;
    }
    .radio-hint {
      font-size: 0.72rem;
      color: #94a3b8;
    }
  </style>
</head>
<body>
  <div class="container">
    <header class="header">
      <div class="header-title">
        <div>
          <h1>
            <span class="live-dot"></span>
            Live 3-Way Dry-Run Radar (S4 vs S6 vs S7)
          </h1>
          <div class="header-subtitle">
            Head-to-Head 3 Skenario Terbaik &bull; Modal Pool <strong>$20.00</strong> Masing-Masing &bull; Wajib <strong>First Buy Ground Zero</strong> &bull; S4: <strong>Single Buy $5</strong> &bull; S6: <strong>Re-Deploy Sniper V2</strong> &bull; S7: <strong>Time-Stop Sniper (Force Sell @ 28s)</strong>
          </div>
        </div>
      </div>
      <div class="nav-group">
        <a href="/add-fol" class="nav-btn">⚡ Live Dashboard</a>
        <a href="/add-fol/backtest-dynamic" class="nav-btn">📊 Backtest V1 ($5 Cap)</a>
        <a href="/add-fol/backtest-dynamic2" class="nav-btn">🚀 Backtest V2 ($20 Pool)</a>
        <a href="/add-fol/3scenarios" class="nav-btn active">📡 Live Radar Multi-Skenario</a>
        <a href="/add-fol/3scenarios/sce4" class="nav-btn" style="color:#f59e0b; border-color:rgba(245,158,11,0.4);">🔍 Detail S4</a>
        <a href="/add-fol/3scenarios/sce5" class="nav-btn" style="color:#f97316; border-color:rgba(249,115,22,0.4);">🌊 Detail S5</a>
        <a href="/add-fol/3scenarios/sce6" class="nav-btn" style="color:#ec4899; border-color:rgba(236,72,153,0.4);">🚀 Detail S6</a>
        <a href="/add-fol/3scenarios/sce7" class="nav-btn" style="color:#06b6d4; border-color:rgba(6,182,212,0.4);">⏱️ Detail S7</a>
        <a href="/add-fol/3scenarios/sce8" class="nav-btn" style="color:#a855f7; border-color:rgba(168,85,247,0.4);">⚡ Detail S8</a>
        <a href="/add-fol/3scenarios/sce9" class="nav-btn" style="color:#3b82f6; border-color:rgba(59,130,246,0.4);">🔄 Detail S9</a>
        <a href="/add-fol/3scenarios/sce9_5" class="nav-btn" style="color:#8b5cf6; border-color:rgba(139,92,246,0.4);">🌙 Detail S9.5</a>
        <a href="/add-fol/3scenarios/sce10" class="nav-btn" style="color:#f59e0b; border-color:rgba(245,158,11,0.4);">🌊 Detail S10</a>
        <a href="/add-fol/3scenarios/sce13" class="nav-btn" style="color:#10b981; border-color:rgba(16,185,129,0.4);">🏓 Detail S13</a>
        <a href="/add-fol/3scenarios/sce13_5" class="nav-btn" style="color:#06b6d4; border-color:rgba(6,182,212,0.4);">⚡ Detail S13.5</a>
      </div>
    </header>

    <!-- Auto-Buy Real API Scenario Selector Bar -->
    <div class="autobuy-bar">
      <div class="autobuy-top">
        <div class="autobuy-title">
          <span>⚡ REAL AUTO-BUY & DRY-RUN CONTROLLER</span>
          <span class="status-pill status-${activeScenario.toLowerCase()}">
            ${activeScenario === 'OFF' ? '⚪ NONAKTIF (OFF)' : (activeScenario === 'DRY_RUN' ? '⚪ SEMUANYA DRY RUN REALISTIS' : (activeScenario === 'S4' ? '🟡 S4 REAL AUTO-BUY AKTIF' : (activeScenario === 'S5' ? '🟠 S5 REAL AUTO-BUY AKTIF' : (activeScenario === 'S6' ? '🟣 S6 REAL AUTO-BUY AKTIF' : (activeScenario === 'S7' ? '🔵 S7 REAL AUTO-BUY AKTIF' : (activeScenario === 'S8' ? '🟣 S8 REAL AUTO-BUY AKTIF' : (activeScenario === 'S9' ? '🔷 S9 REAL AUTO-BUY AKTIF' : (activeScenario === 'S13_BETA' ? '⚡ S13-BETA REAL AUTO-BUY AKTIF' : '🟢 SEMUA REAL AUTO-BUY AKTIF'))))))))}
          </span>
        </div>
        <div style="font-size: 0.78rem; color: #94a3b8;">
          Pilih mode eksekusi: Dry-Run Realistis (simulasi swap ganda tanpa modal) atau Real Order ke GMGN & Solana
        </div>
      </div>

      <div class="autobuy-sub">
        ${activeScenario === 'OFF' 
          ? '⚪ <strong>Keduanya Nonaktif:</strong> Bot idle, tidak ada pemantauan swap.' 
          : (activeScenario === 'DRY_RUN'
              ? '⚪ <strong>Semuanya Dry Run (Simulasi Swap Ganda):</strong> Mekanisme persis seperti buy asli! Hit batch_order diganti hit swap ke-2 untuk simulasi slippage riil. PnL dihitung murni dari harga swap DEX nyata tanpa memotong saldo SOL.'
              : (activeScenario === 'S4' 
                  ? '🟡 <strong>Skenario 4 Saja:</strong> Order NYATA disubmit ke GMGN & blockchain HANYA saat trigger S4 terpenuhi (2-Lapis Shakeout Trap: Hold 8s & Dump on Buyback). Skenario lain berjalan sebagai simulasi.' 
                  : (activeScenario === 'S5' 
                      ? '🟠 <strong>Skenario 5 Saja:</strong> Order NYATA disubmit ke GMGN & blockchain HANYA saat trigger S5 terpenuhi (Anti-Shakeout Runner: Hold >= 12s, TP +25%, Time-Stop 35s). Skenario lain berjalan sebagai simulasi.' 
                      : (activeScenario === 'S6' 
                          ? '🟣 <strong>Skenario 6 Saja:</strong> Order NYATA disubmit ke GMGN & blockchain HANYA saat trigger S6 terpenuhi (Re-Deploy Sniper: TP1 50% @ 5% & TP2 @ 15%). Skenario lain berjalan sebagai simulasi.' 
                          : (activeScenario === 'S7'
                              ? '🔵 <strong>Skenario 7 Saja:</strong> Order NYATA disubmit ke GMGN & blockchain HANYA saat trigger S7 terpenuhi (Time-Stop Sniper: TP1 50% @ 5% & Force Sell 100% @ 28s). Skenario lain berjalan sebagai simulasi.'
                              : (activeScenario === 'S8'
                                  ? '🟣 <strong>Skenario 8 Saja:</strong> Order NYATA disubmit ke GMGN & blockchain HANYA saat trigger S8 terpenuhi (Front-Run Dev Re-Deploy & Dump on Target Entry). Skenario lain berjalan sebagai simulasi.'
                                  : (activeScenario === 'S9'
                                      ? '🔷 <strong>Skenario 9 Saja:</strong> Order NYATA disubmit ke GMGN & blockchain HANYA saat trigger S9 terpenuhi (Dev Front-Run & 2-Way Target Sync: Detik 0 Genesis, Timeout 60s). Skenario lain berjalan sebagai simulasi.'
                                      : '🟢 <strong>Semua Aktif:</strong> Order NYATA disubmit ke GMGN & blockchain saat trigger masing-masing terpenuhi.')))))))}
      </div>

      <!-- Radio Buttons Selection -->
      <div class="scenario-radio-grid">
        <label class="scenario-radio-card ${activeScenario === 'OFF' ? 'active-off' : ''}">
          <input type="radio" name="autobuyScenarioRadio" value="OFF" ${activeScenario === 'OFF' ? 'checked' : ''} onchange="setAutobuyScenario(this.value)">
          <div class="radio-text">
            <span class="radio-main">⚪ Nonaktif (OFF)</span>
            <span class="radio-hint">Bot Idle / Tidak Memantau</span>
          </div>
        </label>

        <label class="scenario-radio-card ${activeScenario === 'DRY_RUN' ? 'active-dryrun' : ''}">
          <input type="radio" name="autobuyScenarioRadio" value="DRY_RUN" ${activeScenario === 'DRY_RUN' ? 'checked' : ''} onchange="setAutobuyScenario(this.value)">
          <div class="radio-text">
            <span class="radio-main" style="color: #38bdf8;">⚪ Semuanya Dry Run</span>
            <span class="radio-hint">Simulasi Swap Ganda (Slippage Riil)</span>
          </div>
        </label>

        <label class="scenario-radio-card ${activeScenario === 'S4' ? 'active-s4' : ''}">
          <input type="radio" name="autobuyScenarioRadio" value="S4" ${activeScenario === 'S4' ? 'checked' : ''} onchange="setAutobuyScenario(this.value)">
          <div class="radio-text">
            <span class="radio-main" style="color: #f59e0b;">🟡 Skenario 4 Saja</span>
            <span class="radio-hint">Single Buy (Exit ≥ 15%) Real</span>
          </div>
        </label>

        <label class="scenario-radio-card ${activeScenario === 'S5' ? 'active-s5' : ''}">
          <input type="radio" name="autobuyScenarioRadio" value="S5" ${activeScenario === 'S5' ? 'checked' : ''} onchange="setAutobuyScenario(this.value)">
          <div class="radio-text">
            <span class="radio-main" style="color: #f97316;">🟠 Skenario 5 Saja</span>
            <span class="radio-hint">Anti-Shakeout (TP +25%) Real</span>
          </div>
        </label>

        <label class="scenario-radio-card ${activeScenario === 'S6' ? 'active-s6' : ''}">
          <input type="radio" name="autobuyScenarioRadio" value="S6" ${activeScenario === 'S6' ? 'checked' : ''} onchange="setAutobuyScenario(this.value)">
          <div class="radio-text">
            <span class="radio-main" style="color: #ec4899;">🟣 Skenario 6 Saja</span>
            <span class="radio-hint">Sniper V2 (TP 5% & 15%) Real</span>
          </div>
        </label>

        <label class="scenario-radio-card ${activeScenario === 'S7' ? 'active-s7' : ''}">
          <input type="radio" name="autobuyScenarioRadio" value="S7" ${activeScenario === 'S7' ? 'checked' : ''} onchange="setAutobuyScenario(this.value)">
          <div class="radio-text">
            <span class="radio-main" style="color: #06b6d4;">🔵 Skenario 7 Saja</span>
            <span class="radio-hint">Time-Stop (TP 5% & Force 28s) Real</span>
          </div>
        </label>

        <label class="scenario-radio-card ${activeScenario === 'S8' ? 'active-s8' : ''}">
          <input type="radio" name="autobuyScenarioRadio" value="S8" ${activeScenario === 'S8' ? 'checked' : ''} onchange="setAutobuyScenario(this.value)">
          <div class="radio-text">
            <span class="radio-main" style="color: #a855f7;">🟣 Skenario 8 Saja</span>
            <span class="radio-hint">Front-Run Dev & Dump on Target</span>
          </div>
        </label>

        <label class="scenario-radio-card ${activeScenario === 'S9' ? 'active-s9' : ''}">
          <input type="radio" name="autobuyScenarioRadio" value="S9" ${activeScenario === 'S9' ? 'checked' : ''} onchange="setAutobuyScenario(this.value)">
          <div class="radio-text">
            <span class="radio-main" style="color: #3b82f6;">🔷 Skenario 9 Saja</span>
            <span class="radio-hint">Dev Front-Run & 2-Way Sync Real</span>
          </div>
        </label>

        <label class="scenario-radio-card ${activeScenario === 'S10' ? 'active-s10' : ''}">
          <input type="radio" name="autobuyScenarioRadio" value="S10" ${activeScenario === 'S10' ? 'checked' : ''} onchange="setAutobuyScenario(this.value)">
          <div class="radio-text">
            <span class="radio-main" style="color: #f59e0b;">⚡ Skenario 10 Saja</span>
            <span class="radio-hint">Dynamic Wave Runner (Whale Sync)</span>
          </div>
        </label>

        <label class="scenario-radio-card ${activeScenario === 'S13_BETA' ? 'active-s13-beta' : ''}">
          <input type="radio" name="autobuyScenarioRadio" value="S13_BETA" ${activeScenario === 'S13_BETA' ? 'checked' : ''} onchange="setAutobuyScenario(this.value)">
          <div class="radio-text">
            <span class="radio-main" style="color: #ec4899;">⚡ Skenario 13-Beta</span>
            <span class="radio-hint">Instant Buy + 1.5s Panic Rescue ($0.25)</span>
          </div>
        </label>

        <label class="scenario-radio-card ${activeScenario === 'BOTH' ? 'active-both' : ''}">
          <input type="radio" name="autobuyScenarioRadio" value="BOTH" ${activeScenario === 'BOTH' ? 'checked' : ''} onchange="setAutobuyScenario(this.value)">
          <div class="radio-text">
            <span class="radio-main" style="color: #10b981;">🟢 Semua Skenario</span>
            <span class="radio-hint">Semua Real Order</span>
          </div>
        </label>
      </div>
    </div>

    <!-- 🎯 Active 1-Dev Radar Live Card -->
    <div class="dev-radar-card" style="background:#0f172a; border:1px solid #1e293b; border-left:4px solid #38bdf8; border-radius:12px; padding:16px 20px; margin-bottom:24px; box-shadow:0 4px 16px rgba(0,0,0,0.25);">
      <div style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:10px; margin-bottom:10px; border-bottom:1px solid rgba(255,255,255,0.06); padding-bottom:8px;">
        <div style="font-size:0.92rem; font-weight:800; display:flex; align-items:center; gap:8px;">
          <span>🎯 ACTIVE 1-DEV RADAR (EARLY REDEPLOY WATCHER)</span>
          <span style="font-size:0.7rem; padding:2px 8px; border-radius:4px; font-weight:800; ${devWatcherState.active ? 'background:rgba(16,185,129,0.2); color:#10b981; border:1px solid rgba(16,185,129,0.4);' : 'background:rgba(148,163,184,0.15); color:#94a3b8; border:1px solid #334155;'}">
            ${devWatcherState.active ? '🟢 AKTIF MEMANTAU 1 DEV (LISTENING WS)' : '⚪ STANDBY / IDLE'}
          </span>
        </div>
        <div style="font-size:0.75rem; color:#64748b; font-family:ui-monospace, monospace;">
          Limit: Maks 1 Dev Wallet Aktif &bull; Zero Delay Execution
        </div>
      </div>

      ${devWatcherState.active && devWatcherState.target ? `
        <div style="display:grid; grid-template-columns:repeat(auto-fit, minmax(220px, 1fr)); gap:12px; font-size:0.82rem; font-family:ui-monospace, monospace;">
          <div style="background:#141e33; padding:8px 12px; border-radius:6px; border:1px solid #1e293b;">
            <div style="font-size:0.68rem; color:#94a3b8; text-transform:uppercase;">Token Sedang Diawasi</div>
            <div style="font-weight:700; color:#38bdf8; margin-top:2px;">${devWatcherState.target.symbol}</div>
            <div style="font-size:0.68rem; color:#64748b; overflow:hidden; text-overflow:ellipsis;">Mint: ${devWatcherState.target.mint}</div>
          </div>

          <div style="background:#141e33; padding:8px 12px; border-radius:6px; border:1px solid #1e293b;">
            <div style="font-size:0.68rem; color:#94a3b8; text-transform:uppercase;">Alamat Dompet Dev</div>
            <div style="font-weight:700; color:#f8fafc; margin-top:2px; display:flex; align-items:center; gap:6px;">
              <span>${devWatcherState.target.devWallet.slice(0, 10)}...${devWatcherState.target.devWallet.slice(-6)}</span>
              <a href="https://solscan.io/account/${devWatcherState.target.devWallet}" target="_blank" style="color:#818cf8; text-decoration:none; font-size:0.75rem;">↗ Solscan</a>
            </div>
            <div style="font-size:0.68rem; color:#10b981;">WebSocket logsSubscribe Connected ✓</div>
          </div>

          <div style="background:#141e33; padding:8px 12px; border-radius:6px; border:1px solid #1e293b;">
            <div style="font-size:0.68rem; color:#94a3b8; text-transform:uppercase;">Sidik Jari IPFS URI</div>
            <div style="font-weight:700; color:#a855f7; margin-top:2px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;" title="${devWatcherState.target.ipfsUri || ''}">
              ${devWatcherState.target.ipfsHash || 'No IPFS Hash'}
            </div>
            <div style="font-size:0.68rem; color:#64748b;">Kunci Pencocokan Generasi 2</div>
          </div>
        </div>
        <div style="font-size:0.75rem; color:#cbd5e1; margin-top:10px; display:flex; align-items:center; gap:6px;">
          <span>⚡</span>
          <span>Jika Dev ini memanggil <code>InitializeCustomizablePool</code> di Meteora, bot akan <strong>LANGSUNG BUY SEBELUM TARGET BUY</strong>. Jika target membeli token lain, token ini otomatis di-SELL 100%.</span>
        </div>
      ` : `
        <div style="font-size:0.8rem; color:#94a3b8;">
          ⚪ <em>Belum ada dev yang dikunci. Begitu Target melakukan First Buy di koin Ground Zero (&le; $0.000020), bot otomatis mengunci 1 dompet dev pembuat koin tersebut dan mulai memantau via WebSocket Solana.</em>
        </div>
      `}
    </div>

    <div class="scenarios-grid">
      ${renderScenarioCard(s4, 'var(--amber)', 'sce4')}
      ${renderScenarioCard(s5, '#10b981', 'sce5')}
      ${renderScenarioCard(s6, '#ec4899', 'sce6')}
      ${renderScenarioCard(s7, '#06b6d4', 'sce7')}
      ${renderScenarioCard(s8, '#a855f7', 'sce8')}
      ${renderScenarioCard(s9, '#3b82f6', 'sce9')}
      ${renderScenarioCard(s9_5, '#8b5cf6', 'sce9_5')}
      ${renderScenarioCard(s10, '#f59e0b', 'sce10')}
      ${renderScenarioCard(s13, '#10b981', 'sce13')}
      ${renderScenarioCard(s13_5, '#06b6d4', 'sce13_5')}
      ${renderScenarioCard(s13_alpha, '#8b5cf6', 'sce13_alpha')}
      ${renderScenarioCard(s13_beta, '#f59e0b', 'sce13_beta')}
      ${renderScenarioCard(s13_alpha_1, '#ec4899', 'sce13_alpha_1')}
      ${renderScenarioCard(s13_beta_1, '#10b981', 'sce13_beta_1')}
      ${renderScenarioCard(s13_centaur, '#38bdf8', 'sce13_centaur')}
      ${renderScenarioCard(s14, '#e11d48', 'sce14')}
      ${renderScenarioCard(s14_alpha, '#6366f1', 'sce14_alpha')}
      ${renderScenarioCard(s14_beta, '#0ea5e9', 'sce14_beta')}
    </div>

    <footer style="text-align: center; font-size: 0.8rem; color: #64748b; margin-top: 24px;">
      cr.bbliong.io/add-fol/3scenarios &bull; Real-time 18-Way Parallel Dry-Run Engine (S4 s/d S14, S14-Alpha & S14-Beta) &bull; Auto-Refresh setiap 5s
    </footer>
  </div>

  <script>
    let isToggling = false;
    function setAutobuyScenario(scenario) {
      if (isToggling) return;
      isToggling = true;
      const curPath = window.location.pathname;
      const ep = curPath.includes('/add-fol') ? '/add-fol/api/autobuy/config' : '/api/autobuy/config';
      const enabled = scenario !== 'OFF';
      fetch(ep, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          autobuyScenario: scenario,
          enabled: enabled
        })
      })
      .then(async r => {
        if (!r.ok) {
          const text = await r.text();
          throw new Error('HTTP ' + r.status + ': ' + text);
        }
        return r.json();
      })
      .then(res => {
        setTimeout(() => location.reload(), 200);
      })
      .catch(err => {
        isToggling = false;
        alert('Gagal mengubah skenario Auto-Buy: ' + err.message);
        location.reload();
      });
    }

    function saveS4Stake() {
      const input = document.getElementById('s4StakeInput');
      if (!input) return;
      const val = parseFloat(input.value);
      if (!Number.isFinite(val) || val < 0.05) {
        alert('Modal S4 minimal $0.05!');
        return;
      }
      sendStakeUpdate({ stakeUsdS4: val }, 'Modal S4 berhasil disimpan: $' + val.toFixed(2));
    }

    function saveS5Stake() {
      const input = document.getElementById('s5StakeInput');
      if (!input) return;
      const val = parseFloat(input.value);
      if (!Number.isFinite(val) || val < 0.05) {
        alert('Modal S5 minimal $0.05!');
        return;
      }
      sendStakeUpdate({ stakeUsdS5: val }, 'Modal S5 berhasil disimpan: $' + val.toFixed(2));
    }

    function saveS6Stake() {
      const p1 = document.getElementById('s6Pool1Input');
      const p2 = document.getElementById('s6Pool2Input');
      if (!p1 || !p2) return;
      const val1 = parseFloat(p1.value);
      const val2 = parseFloat(p2.value);
      if (!Number.isFinite(val1) || val1 < 0.05 || !Number.isFinite(val2) || val2 < 0.05) {
        alert('Modal Pool 1 dan Pool 2 minimal $0.05!');
        return;
      }
      sendStakeUpdate({
        stakeUsdS6Pool1: val1,
        stakeUsdS6Pool2: val2
      }, 'Modal S6 berhasil disimpan: Pool 1 = $' + val1.toFixed(2) + ', Pool 2 = $' + val2.toFixed(2));
    }

    function saveS7Stake() {
      const p1 = document.getElementById('s7Pool1Input');
      const p2 = document.getElementById('s7Pool2Input');
      if (!p1 || !p2) return;
      const val1 = parseFloat(p1.value);
      const val2 = parseFloat(p2.value);
      if (!Number.isFinite(val1) || val1 < 0.05 || !Number.isFinite(val2) || val2 < 0.05) {
        alert('Modal S7 Pool 1 dan Pool 2 minimal $0.05!');
        return;
      }
      sendStakeUpdate({
        stakeUsdS7Pool1: val1,
        stakeUsdS7Pool2: val2
      }, 'Modal S7 berhasil disimpan: Pool 1 = $' + val1.toFixed(2) + ', Pool 2 = $' + val2.toFixed(2));
    }

    function saveS8Stake() {
      const input = document.getElementById('s8StakeInput');
      if (!input) return;
      const val = parseFloat(input.value);
      if (!Number.isFinite(val) || val < 0.05) {
        alert('Modal S8 minimal $0.05!');
        return;
      }
      sendStakeUpdate({
        stakeUsdS8: val
      }, 'Modal S8 berhasil disimpan: $' + val.toFixed(2));
    }

    function saveS9Stake() {
      const input = document.getElementById('s9StakeInput');
      if (!input) return;
      const val = parseFloat(input.value);
      if (!Number.isFinite(val) || val < 0.05) {
        alert('Modal S9 minimal $0.05!');
        return;
      }
      sendStakeUpdate({
        stakeUsdS9: val
      }, 'Modal S9 berhasil disimpan: $' + val.toFixed(2));
    }

    function saveS10Stake() {
      const input = document.getElementById('s10StakeInput');
      if (!input) return;
      const val = parseFloat(input.value);
      if (!Number.isFinite(val) || val < 0.05) {
        alert('Modal S10 minimal $0.05!');
        return;
      }
      sendStakeUpdate({
        stakeUsdS10: val
      }, 'Modal S10 berhasil disimpan: $' + val.toFixed(2));
    }

    function sendStakeUpdate(payload, successMsg) {
      if (isToggling) return;
      isToggling = true;
      const curPath = window.location.pathname;
      const ep = curPath.includes('/add-fol') ? '/add-fol/api/autobuy/config' : '/api/autobuy/config';
      fetch(ep, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      })
      .then(async r => {
        if (!r.ok) {
          const text = await r.text();
          throw new Error('HTTP ' + r.status + ': ' + text);
        }
        return r.json();
      })
      .then(res => {
        alert(successMsg);
        location.reload();
      })
      .catch(err => {
        isToggling = false;
        alert('Gagal menyimpan modal: ' + err.message);
      });
    }

    setInterval(() => {
      const activeEl = document.activeElement;
      const isTyping = activeEl && (activeEl.tagName === 'INPUT' || activeEl.tagName === 'TEXTAREA');
      if (!isToggling && !isTyping) {
        window.location.reload();
      }
    }, 5000);
  </script>
</body>
</html>`;
}
