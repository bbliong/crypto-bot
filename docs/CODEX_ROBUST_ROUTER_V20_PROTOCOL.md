# V20 historical-only robust adaptive router

User requested existing data only; no waiting for a new clock window or live orders.
Two hypotheses, FLOW/SAFETY depth1; cumulative80→82. Frozen before execution.
Native opportunities, unchanged modeled stake$5, fee1%/side, delay1s; delay2s and
fee2%/side stress remain. Candidates choose NATIVE, PEAK_DIRECT, INVALIDATE_500_PRICE,
INVALIDATE_1000_PRICE, PEAK_FULL1500, or WAIT. Frozen old implementations are imported,
not modified. No new entry opportunity universe is claimed.

At opportunity t fit one head/action from strictly available past shadow labels.
Label target = min(net base, net delay2s, net feeStress). Unknown uses the existing
full-stake risk bound, not a claim of realized loss. Availability is the maximum
resolution/captureEnd across all three scenarios; even a good base result cannot
be used before other scenarios resolve. Same min24history/min8leaf/shrink8/gain0.02
and expected-net threshold$0.04 as v8. Choose greatest positive prediction, elseWAIT.
Depth1 only; no tuning of thresholds from future outcomes. Replay costs are modeling
assumptions, not verified receipts or guarantees against rugpull.

Use cached historical TRAIN54/AUDIT29 and stored catch-up6 opportunities ending
4October13:30UTC. TRAIN decisions are prequential. Select FLOW/SAFETY on TRAIN worst
conservative scenario; no trade cannot qualify as profit. AUDIT and catch-up then
continue the SAME causal online learning (including earlier resolved audit labels);
no partition reset of learning, global portfolio also computed chronologically.
These historical periods were examined previously and are not untouched holdouts.
The selected architecture remains fixed; only past-label fitted trees can change.

Promotion must retain >=30closed/3days historical screening, positive all stress,
unknown0 and better risk/PnL than both AGY controls. No live promotion is implemented.
The report shows abstentions, per-period results, cumulative portfolio, and WIB-hour
sample counts. Sparse hour counts do not authorize a trading timetable.
