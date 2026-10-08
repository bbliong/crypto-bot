# Entry-buyer cohort exit v18

Frozen 4 October 2026 before running this study. Four new hypotheses (72 → 76).
AGY source/config/collector unchanged. Entry and fills identical to native baseline;
fallback exit is Codex peak-tracked native exit. Also compare PEAK_DIRECT to isolate effect.

At signal t, fix the set of wallets with net buy USD >=25 in (t−5s,t]. The cohort
must total at least $100. At each fresh post-fill frame, sum cumulative net sell USD
of this fixed cohort after t; buys by cohort members offset sells. Request exit when
outflow reaches 25% or 50% of initial cohort net-buy USD, with at least one or two
wallets individually net-selling >=$25. The four combinations are the entire search.
This detects recycling of initial buying support, not inventory, insider identity,
verified rugpull or future supply. Walletless trades cannot support this signal.
Fallback remains active when cohort evidence is absent. No price-floor fill assumption.

Use existing 54 TRAIN /29 historical AUDIT opportunities and unchanged three execution
scenarios. Select on TRAIN only by worst-scenario conservative PnL, reporting all four
candidates. Audit has already been examined in previous rounds: not holdout.
Use frozen cached input hashes. Select one diagnostic primary even if all fail; apply
existing >=30closed/3day positive-all-stress and risk/control promotion checks. Same
entry invariants must hold. Run selected rule once on fixed-rule catch-up 08:00–13:30 UTC
and label it retrospective diagnostic, not untouched validation (aggregate results seen).
No parameter change based on audit/catch-up. Forward validation, if merited, starts after
freeze and requires original v17 >=100closed/7day criteria; no automatic live promotion.
