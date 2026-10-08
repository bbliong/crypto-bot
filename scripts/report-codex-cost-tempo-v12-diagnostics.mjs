// Ex-post TRAIN diagnostics only; never passed back into the frozen entry policy.
import {readFileSync,writeFileSync,existsSync} from 'node:fs';
import assert from 'node:assert/strict';
import {firstAfter} from './guarded-wave-replay-core.mjs';
import {flowWaveNetReturn} from '../src/codex-flow-wave-v2.ts';
import {studyHash} from './codex-cached-opportunity-study.mjs';
const path='reports/codex-cost-tempo-v12-diagnostics.json';assert.ok(!existsSync(path),'Preserve original diagnostics');
const report=JSON.parse(readFileSync('reports/codex-cost-tempo-v12-results.json'));
assert.ok(report.selected,'No active candidate to diagnose');
const cases=new Map();
for(const f of report.caseFiles){assert.equal(studyHash(f.path),f.sha256);
  for(const c of JSON.parse(readFileSync(f.path)).cases)cases.set(c.session.id,c);
}
const signals=new Map(report.records.map(r=>[r.id,r]));
const rows=report.results.train[report.selected.id].base.rows.map(r=>{
  const signal=signals.get(r.id),c=cases.get(signal.sessionId),h=signal.entryScore.horizonSec;
  const tick=r.buyAt?firstAfter(c.prepared.ticks,r.buyAt+h*1000,Math.min(c.prepared.end,r.buyAt+h*1000+2000)):null;
  const horizonNet=tick?flowWaveNetReturn(5,r.solUsd,r.buyPrice,tick.priceUsd,.01,.000205):null;
  const rawGross=r.status==='CLOSED'?(r.sellPrice/r.buyPrice-1)*100:null;
  const category=r.status!=='CLOSED'?r.status:r.pnl>0?'NET_WIN':rawGross>0?'POSITIVE_PRICE_ERASED_BY_COST':'PRICE_REVERSAL';
  return {id:r.id,mint:r.mint,symbol:r.symbol,category,status:r.status,entryAt:signal.at,entryScore:signal.entryScore,
    actualNet:r.ret,rawGross,horizonSec:h,horizonNet,horizonObservedAt:tick?.observedAt??null,
    heuristicEdgeResidual:horizonNet===null?null:horizonNet-signal.entryScore.edge,
    realizedPnl:r.pnl,buyDelayMs:r.buyAt? r.buyAt-signal.at:null,
    exitReason:r.reason,exitSignalReturn:r.exitSignalReturn??null,fillAfterExitMs:r.at&&r.exitSignalAt?r.at-r.exitSignalAt:null,
    failedSell:r.failedSell??0};
});
const categories=rows.reduce((a,r)=>(a[r.category]=(a[r.category]??0)+1,a),{});
const knownHorizon=rows.filter(r=>r.horizonNet!==null),negativeHorizon=knownHorizon.filter(r=>r.horizonNet<0);
const summary={signals:rows.length,categories,horizonKnown:knownHorizon.length,horizonNegative:negativeHorizon.length,
  meanHeuristicEdge:rows.length?rows.reduce((s,r)=>s+r.entryScore.edge,0)/rows.length:null,
  meanActualHorizonNet:knownHorizon.length?knownHorizon.reduce((s,r)=>s+r.horizonNet,0)/knownHorizon.length:null,
  meanHeuristicResidual:knownHorizon.length?knownHorizon.reduce((s,r)=>s+r.heuristicEdgeResidual,0)/knownHorizon.length:null};
writeFileSync(path,JSON.stringify({generatedAt:new Date().toISOString(),reportHash:studyHash('reports/codex-cost-tempo-v12-results.json'),
  selected:report.selected,partition:'TRAIN_ONLY',summary,rows,
  caveats:['Observed future returns are outcome diagnostics only, not entry inputs or an alternative fitted policy.',
    'Horizon measurement uses first received tick within 2s; missing is not replaced by a favorable price.',
    'Heuristic edge includes a penalty, is not a calibrated expected net, and its residual is not prediction coverage.',
    'Raw positive price / net negative identifies modeled cost-erased returns, not a fee-free strategy.',
    'No test/audit samples used in this diagnostic aggregation.']},null,2),{flag:'wx'});
console.log(JSON.stringify({output:path,selected:report.selected,summary}));
