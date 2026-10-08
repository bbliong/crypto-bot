# V17r1 operational recovery — not a new strategy

4 October 2026. The original worker PID was absent; its last heartbeat was 08:34 UTC.
The cause of process termination is unknown. Live config changed externally at 09:09 UTC;
the original worker now explicitly refuses to resume with SOURCE_CHANGED. Do not restore
or edit that config. Its old hash and new hash are recorded in the recovery manifest.

All executable rules, fee/latency constants, selected policies, labels and original
08:00 UTC start remain unchanged. The replay engine does not read the live config.
V17r1 is a provenance fork accepting this single external change, not silently overriding
the old manifest. Future source/config changes still stop the worker. Previous case
files and decisions are retained, and prefix decisions must match on cumulative replay.
Old ledgers are not overwritten. Catch-up is frozen-rule evaluation on surviving raw,
not proof of uninterrupted forward collection; missing deleted raw cannot be recovered.

Initialize once with `node --import tsx scripts/init-codex-forward-recovery.mjs`.
Run `node --import tsx scripts/run-codex-online-forward-v17r1.mjs --once` for catch-up;
`--follow` continues every 30 minutes, with original seven-day/resource limits.
No live services, wallet, AGY implementation or collector are modified. Detached
processes may still die; verify both PID and heartbeat before claiming the loop is active.
No new trading hypothesis is added: the cumulative family count remains 72.
