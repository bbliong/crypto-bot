# V19 — deterioration-only native setup recheck

Frozen before this round, 4 October 2026. Four configurations (76 → 80 cumulative
families). Do not edit AGY; native exit unchanged. Original entry opportunity from
shared native adapter, followed by 500 or 1000ms observation, then full modeled
execution delay of 1/2s. This is not an in-flight cancellation or latency advantage.

Cancel if fresh price falls >1% from initial signal, developer sells >=$25, known
major seller appears, or one-second collapse <=−8%. FLOW variant additionally
cancels on buy5<50%, return2<0, sellUsd>=100 and >=2 sellers. PRICE variant omits
that additional flow condition. No new 20-second history/holder/age entry filter.
At scheduled recheck (first frame up to250ms later), require fresh price <=750ms
old and original total 9% buy tolerance. No frame means SKIP. After submission,
unchanged fill/retry/unknown rules and native exit; original buy ceiling retained.

TRAIN-only ranking uses existing worst conservative scenario ranking and promotion
criteria (30closed/3days etc). All four configurations reported. Historical AUDIT
is reused and 08:00–13:30 UTC catch-up already seen: diagnostic, not untouched test.
Primary selected before their evaluation. Never select the most profitable audit
variant. Future evaluation, if any, must start after selection and not redefine
fees, unknown losses or the 100closed/7day forward acceptance criteria.
