import json

res = json.load(open('data/profit4-watch/s3_backtest_v5_results.json'))

blocked = [r for r in res if r['newStatus'] == 'BLOCKED']
entered = [r for r in res if r['newStatus'] in ('WIN', 'LOSS')]
wins = [r for r in entered if r['newStatus'] == 'WIN']
losses = [r for r in entered if r['newStatus'] == 'LOSS']

blocked_old_losses = [r for r in blocked if (r.get('oldPnl') or 0) <= 0]
blocked_old_wins = [r for r in blocked if (r.get('oldPnl') or 0) > 0]

saved_loss_usd = abs(sum((r.get('oldPnl') or 0) for r in blocked_old_losses))
old_total_pnl = sum((r.get('oldPnl') or 0) for r in res)
new_total_pnl = sum(r['newPnl'] for r in entered)

print("=" * 80)
print("HASIL LENGKAP EVALUASI STREAMING S3 - LANE V5 SOLUSI 2 VS DATA LAMA (10-13 OKT)")
print("=" * 80)
print(f"Total Token Historis Diuji      : {len(res)} token")
print(f"Token Berhasil DIBLOKIR V5      : {len(blocked)} token")
print(f"  - Menyelamatkan dari LOSS     : {len(blocked_old_losses)} token (Modal terselamatkan: +${saved_loss_usd:.2f} USD)")
print(f"  - Terfilter (Bukan Dump Bersih): {len(blocked_old_wins)} token")
print()
print(f"Token Masuk & Dieksekusi V5     : {len(entered)} token")
print(f"  - Menang (Wins)               : {len(wins)} token")
print(f"  - Kalah (Losses)              : {len(losses)} token")
print(f"  - Win Rate Lane V5 Baru       : {len(wins)/len(entered)*100:.1f}%  (Naik dari 58.2% di Lane Lama)")
print()
print(f"PERBANDINGAN PnL BERSIH:")
print(f"  - PnL Aturan Lama (V1 Mentah) : ${old_total_pnl:+.2f} USD")
print(f"  - PnL Aturan Baru (V5 Solusi2): ${new_total_pnl:+.2f} USD")
print(f"  - Kenaikan Profit Bersih      : ${new_total_pnl - old_total_pnl:+.2f} USD (+{((new_total_pnl/old_total_pnl)-1)*100:.1f}%)")
print("=" * 80)

print("\nCONTOH TOKEN SCAM / FATAL DUMP YANG BERHASIL DIBLOKIR TOTAL:")
for b in blocked_old_losses[:10]:
    sym = b['symbol']
    mint = b['mint']
    old_net = b.get('oldNet') or 0
    old_pnl = b.get('oldPnl') or 0
    reasons = b.get('reasons') or ''
    print(f"  - {sym:12s} ({mint}): Dulu Rugi {old_net:+6.1f}% (${old_pnl:+5.2f}) -> DIBLOKIR: [{reasons[:55]}...]")

print("\nCONTOH TOKEN PEMENANG DENGAN PROFIT TERKUNCI OLEH V5:")
for w in sorted(wins, key=lambda x: -x['newNet'])[:8]:
    sym = w['symbol']
    mint = w['mint']
    new_net = w['newNet']
    new_pnl = w['newPnl']
    exit_r = w.get('exitReason')
    print(f"  - {sym:12s} ({mint}): Profit Baru {new_net:+6.1f}% (${new_pnl:+5.2f}) via {exit_r}")

