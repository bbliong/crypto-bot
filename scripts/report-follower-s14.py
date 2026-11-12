#!/usr/bin/env python3
"""Read-only S14-family report. Never quotes, trades, or mutates runtime state.

Writes immutable snapshot/raw evidence under data/reports and Markdown under docs/reports.
Whale times are observed GMGN target-wallet events, not synthetic probe signals.
Liquidity-drain time stays UNKNOWN without mint-linked transaction evidence.
"""
import hashlib
import json
import subprocess
from collections import Counter
from datetime import datetime
from decimal import Decimal
from pathlib import Path
from zoneinfo import ZoneInfo

ROOT = Path(__file__).resolve().parents[1]
TZ = ZoneInfo('Asia/Jakarta')
TARGET = '3azG8rmtPnNUz77a6UqBKt1ykpk3JQpLLNTaoXW31b34'
KEYS = ('s14', 's14_alpha', 's14_beta')
NAMES = dict(zip(KEYS, ('S14', 'S14-Alpha', 'S15 / S14-Beta')))

def dec(value):
    return Decimal(str(value))

def money(value):
    return f'${dec(value):.2f}'

def clock(ms):
    return datetime.fromtimestamp(ms / 1000, TZ).strftime('%H:%M:%S')

def main():
    now = datetime.now(TZ)
    stamp = now.strftime('%Y%m%d-%H%M%S')
    source = ROOT / 'data/dryrun-3scenarios-live.json'
    source_bytes = source.read_bytes()
    state = json.loads(source_bytes)
    selected = {k: state[k] for k in KEYS}
    mints = {p['mint'] for s in selected.values() for p in s['closedTrades'] + s['openPositions']}
    starts = [p['openedAt'] for s in selected.values() for p in s['closedTrades'] + s['openPositions']]
    earliest = min(starts)
    since = datetime.fromtimestamp(earliest / 1000, TZ).replace(hour=0, minute=0, second=0, microsecond=0)
    journal = subprocess.run([
        'journalctl', '--user', '-u', 'crypto-bot-wallet-follower.service',
        '--since', since.strftime('%Y-%m-%d %H:%M:%S'),
        '--until', now.strftime('%Y-%m-%d %H:%M:%S'), '--no-pager', '-o', 'json'
    ], capture_output=True, text=True, timeout=40, check=True)
    whale, seen, drain_hints = [], set(), []
    for line in journal.stdout.splitlines():
        row = json.loads(line)
        msg = row.get('MESSAGE', '')
        if not isinstance(msg, str):
            continue
        if 'Raw: {' in msg and '[GMGN WS RAW ITEM]' in msg:
            try:
                event = json.loads(msg.split('Raw: ', 1)[1])
            except json.JSONDecodeError:
                continue
            if event.get('a') not in mints or event.get('m') != TARGET or event.get('e') not in ('buy', 'sell'):
                continue
            identity = (event.get('h'), event.get('a'), event.get('e'), event.get('t'))
            if identity not in seen:
                seen.add(identity)
                whale.append({'journalAtUs': row.get('__REALTIME_TIMESTAMP'), 'event': event})
        elif 'DEV-RADAR' in msg and any(w in msg for w in ('RemoveLiquidity', 'Withdraw')):
            # These logs do NOT identify a mint. They cannot establish a rug time.
            drain_hints.append({'journalAtUs': row.get('__REALTIME_TIMESTAMP'), 'message': msg})
    whale.sort(key=lambda r: (r['event']['t'], int(r['event'].get('si') or 0)))
    routes = []
    for line_no, line in enumerate((ROOT / 'data/follower-real-ledger.jsonl').open(), 1):
        try:
            row = json.loads(line)
        except json.JSONDecodeError:
            continue
        detail = row.get('details', {})
        if (detail.get('scenarioId') in {s['id'] for s in selected.values()}
                and detail.get('signal', {}).get('mint') in mints
                and row.get('at', 0) >= earliest - 10000
                and row.get('at', 0) <= int(now.timestamp() * 1000)):
            routes.append({'sourceLine': line_no, 'record': row})
    rawdir = ROOT / 'data/reports' / f'follower-s14-{stamp}'
    rawdir.mkdir(parents=True, exist_ok=False)
    config = json.loads((ROOT / 'data/follower-autobuy-settings.json').read_text())
    raw = {
        'snapshotAt': now.isoformat(), 'sourceSha256': hashlib.sha256(source_bytes).hexdigest(),
        'scope': 'Retained current S14-family session; not an all-history claim',
        'configSafety': {k: config.get(k) for k in ('enabled', 'autobuyScenario', 'autoSell')},
        'scenarios': selected, 'whaleEvents': whale, 'routeEvidence': routes,
        'unattributedDrainLogHints': drain_hints,
        'rugpullStatus': 'UNKNOWN: no mint-linked drain transaction established by this report',
    }
    rawpath = rawdir / 'raw-evidence.json'
    rawpath.write_text(json.dumps(raw, ensure_ascii=False, indent=2) + '\n')
    lines = [
        '# Report dry-run S14, S14-Alpha, S15', '',
        f"Snapshot: **{now.strftime('%Y-%m-%d %H:%M:%S')} WIB**.",
        f"Cakupan: sesi yang masih tersimpan, entry pertama {clock(earliest)} WIB; bukan seluruh histori.",
        '**PAPER ONLY** — hasil quote AMM dan catatan engine, bukan profit wallet nyata.',
        f"Real config: `{json.dumps(raw['configSafety'])}`.", '',
        '## Definisi dan batas bukti',
        '- Win/loss dihitung dari siklus yang sudah FULL EXIT. Partial TP bukan win tambahan.',
        '- Profit/loss utama di bawah memakai closedTrades yang memiliki bukti quote BUY dan SELL sukses. Angka net mengikuti model fee engine; bukan biaya on-chain aktual.',
        '- Profit parsial terbuka dipisahkan. Unrealized berbasis lastPrice tidak dimasukkan sebagai profit AMM yang bisa dicairkan.',
        '- Jam bot adalah waktu event engine. Jam whale adalah timestamp transaksi dari feed GMGN, bukan waktu terima journal; ini belum verifikasi independen blockTime RPC.',
        '- Dump besar didefinisikan eksplisit sebagai SELL whale >=15 SOL. SELL biasa/streak tidak otomatis berarti rugpull.',
        '- Rugpull memerlukan transaksi drain/withdraw terkait mint/pool. Log dev tanpa mint dan sekadar tidak ada quote tidak membuktikan waktu rugpull.',
        '- UNKNOWN berarti belum terverifikasi, bukan jaminan token aman.', '',
    ]
    summaries = {}
    for key, s in selected.items():
        closed = sorted(s['closedTrades'], key=lambda p: p['openedAt'])
        wins = [p for p in closed if dec(p['realizedPnlUsd']) > 0]
        losses = [p for p in closed if dec(p['realizedPnlUsd']) < 0]
        bep = [p for p in closed if dec(p['realizedPnlUsd']) == 0]
        profit = sum((dec(p['realizedPnlUsd']) for p in wins), Decimal(0))
        loss = -sum((dec(p['realizedPnlUsd']) for p in losses), Decimal(0))
        partial = sum((dec(p.get('stage1RealUsdReturned', 0)) - (dec(p['initialCostBasisUsd']) - dec(p['costBasisUsd']))
                       for p in s['openPositions'] if p.get('stage1Exited')), Decimal(0))
        closed_net = profit - loss
        summary = dict(wins=len(wins), losses=len(losses), bep=len(bep), closed=len(closed),
                       open=len(s['openPositions']), profit=str(profit), loss=str(loss),
                       closedNet=str(closed_net), partialQuotePnl=str(partial),
                       closedPlusPartialQuotePnl=str(closed_net + partial),
                       dashboardRealizedPnl=s['realizedPnl'])
        summaries[key] = summary
        lines += [f'## {NAMES[key]}',
                  f"- Full exit: **{len(wins)} win / {len(losses)} loss / {len(bep)} BEP**; terbuka: {len(s['openPositions'])} posisi.",
                  f'- Keuntungan trade selesai: **+{money(profit)}**; kerugian trade selesai: **-{money(loss)}**; net: **+{money(closed_net)}**.',
                  f'- Profit quote parsial posisi yang masih terbuka: **+{money(partial)}**.',
                  f'- Closed + partial quote: **+{money(closed_net + partial)}**, sebelum rekonsiliasi kas keseluruhan.',
                  f"- Kas tercatat: {money(s['availableCash'])}; modal awal tercatat: {money(s['initialCash'])}.",
                  f"- PnL realized dashboard: {money(s['realizedPnl'])}. Berbeda dari closed + partial quote; jangan disamakan dengan laba wallet terverifikasi.", '']
        for index, p in enumerate(sorted(closed + s['openPositions'], key=lambda p: p['openedAt']), 1):
            is_closed = 'closedAt' in p
            end = p.get('closedAt', int(now.timestamp() * 1000))
            matching = [r for r in routes if r['record']['details']['scenarioId'] == s['id']
                        and r['record']['details']['signal']['mint'] == p['mint']
                        and p['openedAt'] - 2000 <= r['record']['at'] <= end + 5000]
            ok_quotes = [r for r in matching if r['record']['details'].get('response', {}).get('swap', {}).get('ok') is True
                         and r['record']['details']['response']['swap'].get('quote', {}).get('outAmount')]
            counts = Counter(r['record']['details']['request']['swap']['side'] for r in ok_quotes)
            if is_closed:
                assert counts['BUY'] >= 1 and counts['SELL'] >= 1, (key, p['symbol'], 'MISSING_QUOTE_PROOF')
            events = sorted((e for e in s.get('recentEvents', []) if e.get('mint') == p['mint']
                             and p['openedAt'] <= e.get('timestamp', 0) <= end), key=lambda e: e['timestamp'])
            lines += [f"### {index}. {p['symbol']} — {'CLOSED' if is_closed else 'OPEN'}",
                      f"- Mint: `{p['mint']}`", f"- Bot BUY: **{clock(p['openedAt'])} WIB**."]
            if is_closed:
                lines += [f"- Modal entry tercatat: {money(p['totalInvestedUsd'])}; hasil kembali bersih seluruh exit: {money(p['totalReturnedUsd'])}.",
                          f"- Hasil: **{money(p['realizedPnlUsd'])} / {p['roiPct']}%**; fee ledger: {money(p['totalFeesPaidUsd'])}.",
                          f"- Bot FULL EXIT: **{clock(p['closedAt'])} WIB**.", f"- Alasan exit asli: `{p['exitReason']}`."]
            else:
                lines += [f"- Modal entry tercatat: {money(p.get('initialCostBasisUsd', p['costBasisUsd']))}; cost basis tersisa: {money(p['costBasisUsd'])}.",
                          '- Bot FULL EXIT: **belum ada di state**; hasil akhir belum ditentukan.']
            if p.get('stage1RealUsdReturned'):
                tp = [e for e in events if e.get('action') == 'SELL' and 'STAGE_1_TP_50%' in e.get('reason', '')]
                tp_time = clock(tp[0]['timestamp']) if tp else clock(p['stage1ExitedAt']) if p.get('stage1ExitedAt') else 'UNKNOWN'
                lines += [f"- TP tahap 1, jual 50%: **{tp_time} WIB**; hasil quote bersih **{money(p['stage1RealUsdReturned'])}**. Jangan menambahkan hasil ini lagi ke totalReturned closed trade."]
            buy_event = next((e for e in events if e.get('action') == 'BUY'), None)
            entry = p.get('totalInvestedUsd', p.get('initialCostBasisUsd', p['costBasisUsd'] if 'costBasisUsd' in p else 0))
            if buy_event and abs(dec(buy_event['stakeUsd']) - dec(entry)) > Decimal('0.02'):
                lines += [f"- **ACCOUNTING_PARTIAL:** event BUY menulis stake {money(buy_event['stakeUsd'])}, sedangkan posisi/quote memakai {money(entry)}. Nilai modal/kas belum rekonsiliasi; report tidak mengubah data ini."]
            lines += [f"- Bukti quote sukses tersimpan: BUY {counts['BUY']}, SELL {counts['SELL']}; source line: {', '.join(str(r['sourceLine']) for r in ok_quotes)}.",
                      '- Jam whale dan rugpull: lihat lifecycle mint di bagian berikut.', '']
    lines += ['## Lifecycle whale dan rugpull per mint', '']
    for mint in sorted(mints):
        w = [r['event'] for r in whale if r['event']['a'] == mint]
        buys = [e for e in w if e['e'] == 'buy']
        sells = [e for e in w if e['e'] == 'sell']
        symbol = next(p['symbol'] for s in selected.values() for p in s['closedTrades'] + s['openPositions'] if p['mint'] == mint)
        lines += [f'### {symbol}', f'- Mint: `{mint}`']
        for label, event in [('Whale BUY pertama teramati', buys[0] if buys else None),
                             ('Whale SELL pertama teramati', sells[0] if sells else None),
                             ('Whale SELL terbesar teramati', max(sells, key=lambda e: dec(e.get('qa') or 0)) if sells else None)]:
            if event:
                lines += [f"- {label}: **{clock(event['t'] * 1000)} WIB**, {dec(event.get('qa') or 0):.4f} SOL; tx `{event['h']}`."]
            else:
                lines += [f'- {label}: **UNKNOWN**.']
        giant = [e for e in sells if dec(e.get('qa') or 0) >= 15]
        lines += [f"- Dump besar >=15 SOL: {', '.join(clock(e['t'] * 1000) + ' WIB' for e in giant) if giant else 'tidak ditemukan dalam feed yang tersimpan; bukan bukti tidak pernah terjadi' }.",
                  '- Token rugpull / waktu drain: **UNKNOWN — belum ada bukti transaksi drain terkait mint ini dalam report**.',
                  f'- Cakupan whale: {len(buys)} BUY / {len(sells)} SELL teramati. Semua raw event disertakan di JSON.', '']
    lines += ['## Audit kualitas angka',
              '- Status keseluruhan: **PARTIAL**. Quote BUY/SELL tersedia, tetapi kas/event BUY, dashboard realized dan partial AMM belum seluruhnya konsisten.',
              '- Tidak memakai unrealized spot sebagai keuntungan yang sudah bisa dicairkan. Nilai posisi open dapat stale; tidak dilakukan quote liquidation baru oleh report ini.',
              '- Bukti rugpull berstatus UNKNOWN; log RemoveLiquidity/Withdraw tanpa mint disimpan sebagai petunjuk saja, bukan atribusi ke token.',
              '- Fee net adalah model yang dicatat engine, bukan pengukuran biaya transaksi nyata.',
              '- Ledger membatasi retensi histori. Jumlah di atas hanya trade yang ada pada snapshot, bukan total sejak instalasi bot.', '',
              '## Sumber dan raw', f'- Snapshot source SHA-256: `{raw["sourceSha256"]}`.',
              f'- Raw evidence: `{rawpath}`.',
              '- State: `data/dryrun-3scenarios-live.json`; quote: `data/follower-real-ledger.jsonl`; whale: journal service wallet follower.',
              '- Tidak ada perubahan config/service/trading dari script report ini.', '']
    output = ROOT / 'docs/reports' / f'follower-s14-{stamp}.md'
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text('\n'.join(lines))
    (rawdir / 'summary.json').write_text(json.dumps(summaries, indent=2) + '\n')
    assert len(summaries) == len(KEYS)
    assert sum(s['closed'] + s['open'] for s in summaries.values()) == sum(len(s['closedTrades']) + len(s['openPositions']) for s in selected.values())
    print(json.dumps({'report': str(output), 'raw': str(rawpath), 'summary': summaries,
                      'whaleEventCount': len(whale), 'quoteRows': len(routes),
                      'unattributedDrainHints': len(drain_hints)}, indent=2))

if __name__ == '__main__':
    main()
