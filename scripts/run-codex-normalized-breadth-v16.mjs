import {runBreadthStudy} from './codex-breadth-study-runner.mjs';
import {NORMALIZED_CONFIGS,normalizedEventsV16,evaluateNormalizedV16} from './codex-normalized-breadth-v16.mjs';
await runBreadthStudy({prefix:'codex-normalized-breadth-v16',protocol:'docs/CODEX_NORMALIZED_BREADTH_V16_PROTOCOL.md',
  files:['scripts/codex-normalized-breadth-v16.mjs','scripts/run-codex-normalized-breadth-v16.mjs'],eventFactory:normalizedEventsV16,
  evaluator:evaluateNormalizedV16,configs:NORMALIZED_CONFIGS,cumulativeHypotheses:71,forwardStart:Date.parse('2026-10-04T08:00Z')});
