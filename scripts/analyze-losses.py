import json

res = json.load(open('data/profit4-watch/s3_backtest_v5_results.json'))
losses = [r for r in res if r['newStatus'] == 'LOSS']

reasons = {}
loss_amts = []
loss_pcts = []

for l in losses:
    r = l.get('exitReason', 'UNKNOWN')
    reasons[r] = reasons.get(r, 0) + 1
    loss_amts.append(l['newPnl'])
    loss_pcts.append(l['newNet'])

print("=" * 70)
print(f"ANALISIS 28 TOKEN LOSS DI LANE V5")
print("=" * 70)
print(f"Total Token Loss: {len(losses)}")
print(f"Rata-rata Rugi  : {sum(loss_pcts)/len(loss_pcts):.2f}% (${sum(loss_amts)/len(loss_amts):.2f} USD)")
print(f"Rentang Rugi    : {max(loss_pcts):.2f}% s/d {min(loss_pcts):.2f}%")
print()
print("DISTRIBUSI ALASAN EXIT:")
for k, v in sorted(reasons.items(), key=lambda x: -x[1]):
    print(f"  * {k:<30}: {v:2d} token ({v/len(losses)*100:5.1f}%)")

print()
print("DAFTAR 28 TOKEN LOSS:")
print(f"{'No':<3} | {'Symbol':<15} | {'Mint':<6} | {'New PnL':<15} | {'Old PnL':<15} | {'Exit Reason'}")
print("-" * 75)
for i, l in enumerate(losses, 1):
    sym = l.get('symbol', 'N/A')[:14]
    mint = l.get('mint', '')[:6]
    new_pnl_str = f"{l['newNet']:+5.1f}% (${l['newPnl']:+.2f})"
    old_net = l.get('oldNet') or 0
    old_pnl = l.get('oldPnl') or 0
    old_pnl_str = f"{old_net:+5.1f}% (${old_pnl:+.2f})"
    reason = l.get('exitReason', 'N/A')
    print(f"{i:2d}  | {sym:<15} | {mint:<6} | {new_pnl_str:<15} | {old_pnl_str:<15} | {reason}")
