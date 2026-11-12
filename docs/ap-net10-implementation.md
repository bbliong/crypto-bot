# AP paper accounting / net TP10 implementation

## Accounting boundary

New AP positions use accounting version 2, provenance `PAPER_AMM_QUOTE`, and the explicit **paper estimate** $0.025 per swap leg. BUY reserves principal + buy fee without inventing tokens. Only the selected second BUY quote fills the position. Both probes are audited in `ap-paper-quotes.jsonl`; probe-2 throw, malformed or no-route refunds once. The runner preserves engine affordable stake (initial $5 cash → $4.975 principal).

SELL first records an intent. No cash, token reduction, realized profit, or closed record is booked until a matching SELL quote arrives. Lane/mint/position UUID/revision/request UUID/quantity/pair must match. Partial sale allocates remaining principal and buy fee proportionally; SELL subtracts only its own sell fee. Whole-cycle net PnL is summed sell net proceeds minus initial cash outlay. No-route and administrative stagnant timeout preserve unresolved exposure instead of reporting a fictitious -100% liquidation. Duplicate/stale/pre-restart callbacks cannot settle twice.

Existing historical records are not recomputed or claimed reconciled. Records without accounting version 2 are **legacy-unreconciled**. Existing open legacy positions are not converted using invented quantities. Durable per-lane `apBoughtMints` is seeded only from available saved history/open positions and persists beyond display history trimming; it cannot recover history already deleted before this change.

## Offline verification

The independent AP monitor runs on a 1-second runner timer: fair round-robin, at most 2 concurrent tasks, 5-second per-position cooldown and quote TTL, 4-second outer timeout, 3.5-second abortable in-page SELL fetch, one route attempt per cycle. It scans only active AP positions, uses paper base units/decimals/pair, never wallet balances or spot proceeds. No-route/timeout retain exposure and failure metadata; retries use a new request identity. Whole-position observation quotes may trigger original TP/SL rules; actual partial exits still require exact partial quotes. Legacy open records without exact quote provenance remain unreconciled/unpriced rather than guessed into liquidation. No new whale, trailing or SL policy is added.

Strict RED/GREEN logs live in `$TMPDIR/ap-net10-A-*`. Focused accounting and actual runner prototype tests exercise isolated scratch directories and injected quote dependencies, not market quotes or real orders. The no-rebuy regression fixture now explicitly settles paper quotes; it no longer depends on spot phantom fills.

No service restart, live-state/config write, browser, RPC, remote market request, signing, broadcast, or deployment is part of implementation verification. Existing full-project typecheck diagnostics are compared against a pre-change snapshot, not declared clean.

## Capital / cohort warning

Original AP1/AP2/AP3 controls and their historical capital remain untouched. Additive net10 lanes begin with fresh $5 paper cash. The existing controls may have exhausted capital and traded a different cohort: **unmatched legacy capital cohort — not a fair performance A/B comparison**. Historical alternate-trigger executable SELL quotes are unavailable; historical alternative return remains UNKNOWN. Fixture results are not strategy profitability evidence.
