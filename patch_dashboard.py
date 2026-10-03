import re

with open("scripts/serve-aggressive-dashboard-agy.mjs", "r") as f:
    text = f.read()

# Duplicate CSS tag
text = text.replace(
    ".tag-lane-wave { background: rgba(20, 184, 166, 0.2); color: #2dd4bf; border: 1px solid rgba(45, 212, 191, 0.4); }",
    ".tag-lane-wave { background: rgba(20, 184, 166, 0.2); color: #2dd4bf; border: 1px solid rgba(45, 212, 191, 0.4); }\n    .tag-lane-adaptive { background: rgba(16, 185, 129, 0.2); color: #34d399; border: 1px solid rgba(52, 211, 153, 0.4); }"
)
text = text.replace(
    ".lane-card-wave {\n      background: rgba(13, 148, 136, 0.22);\n      border: 1px solid rgba(45, 212, 191, 0.4);\n    }",
    ".lane-card-wave {\n      background: rgba(13, 148, 136, 0.22);\n      border: 1px solid rgba(45, 212, 191, 0.4);\n    }\n    .lane-card-adaptive {\n      background: rgba(6, 78, 59, 0.22);\n      border: 1px solid rgba(52, 211, 153, 0.4);\n    }"
)

# Fix HTML Card
old_wave_card = """      <!-- Wave Scalper Lane Card -->
      <div class="lane-card lane-card-wave">
        <div style="display: flex; justify-content: space-between; align-items: center;">
          <span style="font-weight: 800; font-size: 0.88rem; color: #2dd4bf;">⚡ ADAPTIVE WAVE V1</span>
          <span class="tag tag-lane-wave">Smart Momentum · Max -6% Loss</span>
        </div>
        <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 8px;">
          <div>
            <div class="kpi-label">Real Win Rate</div>
            <div id="waveRealWinRate" class="kpi-value mono">0.0%</div>
            <div id="waveRealScore" class="kpi-sub">0W / 0L</div>
          </div>
          <div>
            <div class="kpi-label">Net Real Profit ($)</div>
            <div id="waveRealPnl" class="kpi-value mono">$0.0000</div>
            <div id="waveSocketScore" class="kpi-sub" style="color: #2dd4bf;">Socket: 0.0% ($0.00)</div>
          </div>
        </div>
        <div id="waveTrapNote" style="font-size: 0.66rem; color: #99f6e4; border-top: 1px dashed rgba(45, 212, 191, 0.3); padding-top: 5px;">
          ⚡ Rules: Target Dinamis ATH (Min +20%) | Runner Trail 5% (&ge;18%) | Breakeven +10% | Turun Ditunggu (Stop -6.0%)
        </div>
      </div>"""

new_cards = """      <!-- Original Wave Scalper Lane Card -->
      <div class="lane-card lane-card-wave">
        <div style="display: flex; justify-content: space-between; align-items: center;">
          <span style="font-weight: 800; font-size: 0.88rem; color: #2dd4bf;">⚡ AGGRESSIVE WAVE</span>
          <span class="tag tag-lane-wave">Wave Maximizer · Min +20%</span>
        </div>
        <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 8px;">
          <div>
            <div class="kpi-label">Real Win Rate</div>
            <div id="waveRealWinRate" class="kpi-value mono">0.0%</div>
            <div id="waveRealScore" class="kpi-sub">0W / 0L</div>
          </div>
          <div>
            <div class="kpi-label">Net Real Profit ($)</div>
            <div id="waveRealPnl" class="kpi-value mono">$0.0000</div>
            <div id="waveSocketScore" class="kpi-sub" style="color: #2dd4bf;">Socket: 0.0% ($0.00)</div>
          </div>
        </div>
        <div id="waveTrapNote" style="font-size: 0.66rem; color: #99f6e4; border-top: 1px dashed rgba(45, 212, 191, 0.3); padding-top: 5px;">
          ⚡ Rules: Target Dinamis ATH (Min +20%) | Runner Trail 5% (&ge;18%) | Breakeven +10% | Turun Ditunggu (Stop -6.0%)
        </div>
      </div>

      <!-- New Adaptive Wave V1 Card -->
      <div class="lane-card lane-card-adaptive">
        <div style="display: flex; justify-content: space-between; align-items: center;">
          <span style="font-weight: 800; font-size: 0.88rem; color: #34d399;">💎 ADAPTIVE WAVE V1</span>
          <span class="tag tag-lane-adaptive">Smart Momentum · Max -6% Loss</span>
        </div>
        <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 8px;">
          <div>
            <div class="kpi-label">Real Win Rate</div>
            <div id="adaptiveRealWinRate" class="kpi-value mono">0.0%</div>
            <div id="adaptiveRealScore" class="kpi-sub">0W / 0L</div>
          </div>
          <div>
            <div class="kpi-label">Net Real Profit ($)</div>
            <div id="adaptiveRealPnl" class="kpi-value mono">$0.0000</div>
            <div id="adaptiveSocketScore" class="kpi-sub" style="color: #34d399;">Socket: 0.0% ($0.00)</div>
          </div>
        </div>
        <div id="adaptiveTrapNote" style="font-size: 0.66rem; color: #a7f3d0; border-top: 1px dashed rgba(52, 211, 153, 0.3); padding-top: 5px;">
          💎 Rules: Strict Entry (MC 10k-100k, Vol 300+) | Trail Runner | Auto Breakeven
        </div>
      </div>"""

text = text.replace(old_wave_card, new_cards)

# Fix Filter Buttons
text = text.replace(
    '<button id="btnFilterWave" class="btn-filter" onclick="setLaneFilter(\'aggressive-wave\')">⚡ Adaptive Wave V1</button>',
    '<button id="btnFilterWave" class="btn-filter" onclick="setLaneFilter(\'aggressive-wave\')">⚡ Aggressive Wave</button>\n          <button id="btnFilterAdaptive" class="btn-filter" onclick="setLaneFilter(\'adaptive-wave\')">💎 Adaptive Wave V1</button>'
)

# Fix Active Class for Buttons
text = text.replace(
    "if (btnWave) btnWave.className = 'btn-filter' + (lane === 'aggressive-wave' ? ' active' : '');",
    "if (btnWave) btnWave.className = 'btn-filter' + (lane === 'aggressive-wave' ? ' active' : '');\n      const btnAdaptive = document.getElementById('btnFilterAdaptive');\n      if (btnAdaptive) btnAdaptive.className = 'btn-filter' + (lane === 'adaptive-wave' ? ' active' : '');"
)

# Fix Badges in Logs
text = text.replace(
    "const laneBadge = t.lane === 'aggressive-wave'\n        ? '<span class=\"tag tag-lane-wave\">ADAPTIVE WAVE V1</span>'",
    "const laneBadge = t.lane === 'adaptive-wave' ? '<span class=\"tag tag-lane-adaptive\">ADAPTIVE V1</span>' : t.lane === 'aggressive-wave'\n        ? '<span class=\"tag tag-lane-wave\">WAVE SCALPER</span>'"
)
text = text.replace(
    "const laneBadge = p.lane === 'aggressive-wave'\n            ? '<span class=\"tag tag-lane-wave\">ADAPTIVE WAVE V1</span>'",
    "const laneBadge = p.lane === 'adaptive-wave' ? '<span class=\"tag tag-lane-adaptive\">ADAPTIVE V1</span>' : p.lane === 'aggressive-wave'\n            ? '<span class=\"tag tag-lane-wave\">WAVE SCALPER</span>'"
)

# Fix Text Label in Legend
text = text.replace(
    "const laneLabel = lane === 'aggressive-wave' ? 'Wave Scalper Aggressive'",
    "const laneLabel = lane === 'adaptive-wave' ? 'Adaptive Wave V1' : lane === 'aggressive-wave' ? 'Wave Scalper Aggressive'"
)

# Backend Stats Extraction
text = text.replace(
    "const waveTrades = closedTrades.filter(t => t.lane === 'aggressive-wave');",
    "const waveTrades = closedTrades.filter(t => t.lane === 'aggressive-wave');\n      const adaptiveTrades = closedTrades.filter(t => t.lane === 'adaptive-wave');"
)
text = text.replace(
    "wave: { ...waveSummary, dumpPreventedCount: 0 },",
    "wave: { ...waveSummary, dumpPreventedCount: 0 },\n          adaptive: { ...summarizeMetrics(adaptiveTrades), dumpPreventedCount: 0 },"
)

# Frontend Stats Update
stats_update = """          if (s.wave) {
            const waveWrEl = document.getElementById('waveRealWinRate');
            if (waveWrEl) {
              waveWrEl.textContent = s.wave.realWinRate + '%';
              waveWrEl.className = 'kpi-value mono ' + (s.wave.realWinRate > 0 ? 'up' : (s.wave.closedTrades > 0 ? 'down' : ''));
            }
            const waveScoreEl = document.getElementById('waveRealScore');
            if (waveScoreEl) waveScoreEl.textContent = s.wave.realWins + 'W / ' + s.wave.realLosses + 'L (' + s.wave.closedTrades + ' closed)';
            const wavePnlEl = document.getElementById('waveRealPnl');
            if (wavePnlEl) {
              wavePnlEl.textContent = (s.wave.totalNetRealPnlUsd >= 0 ? '+' : '') + '$' + s.wave.totalNetRealPnlUsd.toFixed(4);
              wavePnlEl.className = 'kpi-value mono ' + (s.wave.totalNetRealPnlUsd >= 0 ? 'up' : 'down');
            }
            const waveSocketEl = document.getElementById('waveSocketScore');
            if (waveSocketEl) {
              waveSocketEl.textContent = 'Socket: ' + s.wave.socketWinRate + '% (' + (s.wave.totalNetTradePnlUsd >= 0 ? '+' : '') + '$' + s.wave.totalNetTradePnlUsd.toFixed(2) + ')';
            }
          }"""

new_stats_update = stats_update + """
          if (s.adaptive) {
            const wrEl = document.getElementById('adaptiveRealWinRate');
            if (wrEl) {
              wrEl.textContent = s.adaptive.realWinRate + '%';
              wrEl.className = 'kpi-value mono ' + (s.adaptive.realWinRate > 0 ? 'up' : (s.adaptive.closedTrades > 0 ? 'down' : ''));
            }
            const scoreEl = document.getElementById('adaptiveRealScore');
            if (scoreEl) scoreEl.textContent = s.adaptive.realWins + 'W / ' + s.adaptive.realLosses + 'L (' + s.adaptive.closedTrades + ' closed)';
            const pnlEl = document.getElementById('adaptiveRealPnl');
            if (pnlEl) {
              pnlEl.textContent = (s.adaptive.totalNetRealPnlUsd >= 0 ? '+' : '') + '$' + s.adaptive.totalNetRealPnlUsd.toFixed(4);
              pnlEl.className = 'kpi-value mono ' + (s.adaptive.totalNetRealPnlUsd >= 0 ? 'up' : 'down');
            }
            const socketEl = document.getElementById('adaptiveSocketScore');
            if (socketEl) {
              socketEl.textContent = 'Socket: ' + s.adaptive.socketWinRate + '% (' + (s.adaptive.totalNetTradePnlUsd >= 0 ? '+' : '') + '$' + s.adaptive.totalNetTradePnlUsd.toFixed(2) + ')';
            }
          }
"""

text = text.replace(stats_update, new_stats_update)


with open("scripts/serve-aggressive-dashboard-agy.mjs", "w") as f:
    f.write(text)

