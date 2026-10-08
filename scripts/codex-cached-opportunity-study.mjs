// Reporting/selection mechanics shared by subsequent finite offline studies.
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
import {exitStats,wibDay} from './codex-same-entry-analysis.mjs';
import {simulateOnePosition} from './codex-portfolio.mjs';
export const STUDY_SCENARIOS=[['base',1000,.01],['delay2s',2000,.01],['feeStress',1000,.02]];
export const studyHash=p=>createHash('sha256').update(readFileSync(p)).digest('hex');
export function cachedOpportunityStudy(){
  const parent=JSON.parse(readFileSync('reports/codex-engineering-v5b-results.json'));
  const data=JSON.parse(readFileSync('reports/codex-engineering-v5-dataset.json'));
  assert.equal(studyHash('reports/codex-engineering-v5-dataset.json'),parent.datasetHash);
  for(const[p,h]of Object.entries(parent.hashes))assert.equal(studyHash(p),h,`Changed cached dependency ${p}`);
  return {parent,cases:new Map(data.cases.map(c=>[c.signal.id,c]))};
}
export function evaluateCachedCandidate(cases,opportunityRows,config,evaluator,end){
  return Object.fromEntries(STUDY_SCENARIOS.map(([s,delayMs,feeSide])=>{
    const rows=opportunityRows.map(r=>{const c=cases.get(r.id);let o=evaluator(c.signal,c.prepared,config,{delayMs,feeSide});
      if(o.at!==null&&o.at>=end&&o.status!=='SKIP')o={...o,status:'PARTITION_UNKNOWN',pnl:null,ret:null,at:null};
      return {id:r.id,mint:r.mint,symbol:r.symbol,opportunityAt:r.signalAt,signalAt:o.decisionAt??r.signalAt,
        day:wibDay(o.decisionAt??r.signalAt),captureEnd:r.captureEnd,solUsd:r.solUsd,solAssumed:r.solAssumed,...o,
        bound:o.pnl??-(5+.000205*r.solUsd+(o.failedSell??0)*.000105*r.solUsd)};
    });
    const active=rows.filter(r=>r.status!=='SKIP'),portfolio=simulateOnePosition(active,5);
    return[s,{summary:{...exitStats(active),opportunities:rows.length,skips:rows.length-active.length},
      portfolio:{...portfolio,selectedIds:undefined},rows}];
  }));
}
export const compactStudy=rs=>Object.fromEntries(Object.entries(rs).map(([s,r])=>[s,{...r,rows:undefined}]));
export function rankCachedCandidates(configs,cases,rows,evaluator,end){
  return configs.map(config=>{const results=evaluateCachedCandidate(cases,rows,config,evaluator,end),s=results.base.summary;
    return {config,results,enough:s.closed>=10&&s.days>=3,score:Math.min(...Object.values(results).map(x=>x.summary.conservativePnl))};
  }).sort((a,b)=>Number(b.enough)-Number(a.enough)||b.score-a.score||b.results.base.summary.closed-a.results.base.summary.closed);
}
export function studyTrainingPassed(primary,controls){
  return !!primary&&primary.results.base.summary.closed>=30&&primary.results.base.summary.days>=3&&
    STUDY_SCENARIOS.every(([s])=>{const c=primary.results[s].summary;return c.conservativePnl>0&&c.unknown===0&&
      ['AGY_NATIVE','AGY_REFERENCE'].every(b=>{const v=controls[b][s].summary;return c.conservativePnl>v.conservativePnl&&
        c.eventBoundDrawdown<=v.eventBoundDrawdown&&c.tailLoss10<=v.tailLoss10;});});
}
