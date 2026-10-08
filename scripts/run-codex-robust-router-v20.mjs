import {readFileSync,writeFileSync,existsSync} from 'node:fs';
import assert from 'node:assert/strict';
import {ROBUST_ACTIONS,ROBUST_CONFIGS,evaluateRobustActionV20,robustLabelsV20,robustDecisionV20} from './codex-robust-router-v20.mjs';
import {cachedOpportunityStudy,studyHash,evaluateCachedCandidate,compactStudy,studyTrainingPassed,STUDY_SCENARIOS} from './codex-cached-opportunity-study.mjs';
import {exitStats} from './codex-same-entry-analysis.mjs';
import {simulateOnePosition} from './codex-portfolio.mjs';
const out='reports/codex-robust-router-v20';assert.ok(!existsSync(`${out}-selection.json`),'Frozen output exists');
const {parent,cases}=cachedOpportunityStudy();
const snapshotPath='reports/codex-online-forward-v17r1/snapshots/20261004T133000000Z.json';
const snapshot=JSON.parse(readFileSync(snapshotPath)),ledger=JSON.parse(readFileSync(snapshot.ledger));
const hashes={...parent.hashes,...Object.fromEntries(['docs/CODEX_ROBUST_ROUTER_V20_PROTOCOL.md',
  'scripts/codex-robust-router-v20.mjs','scripts/run-codex-robust-router-v20.mjs',
  'scripts/codex-evidence-wave-v8.mjs','scripts/codex-peak-recheck-v10.mjs','scripts/codex-prebuy-recheck-v9.mjs',
  'scripts/codex-invalidation-v19.mjs','scripts/codex-cached-opportunity-study.mjs',snapshotPath,snapshot.ledger].map(p=>[p,studyHash(p)]))};
for(const line of readFileSync('reports/codex-online-forward-v17r1/sessions.jsonl','utf8').trim().split('\n')){
  const e=JSON.parse(line);if(e.caseFile){assert.equal(studyHash(e.caseFile.path),e.caseFile.sha256);
    hashes[e.caseFile.path]=e.caseFile.sha256;const c=JSON.parse(readFileSync(e.caseFile.path));cases.set(c.signal.id,c);}
}
const signals=new Map([...cases].map(([id,c])=>[id,c.signal]));
const controls={train:parent.results.train,audit:parent.results.audit,catchup:ledger.results};
function actions(part,end){return Object.fromEntries(ROBUST_ACTIONS.map(a=>[a,
  evaluateCachedCandidate(cases,controls[part].AGY_NATIVE.base.rows,a,evaluateRobustActionV20,end)]));}
function summarize(rows){const active=rows.filter(r=>r.status!=='SKIP');return {
  summary:{...exitStats(active),opportunities:rows.length,skips:rows.length-active.length},portfolio:simulateOnePosition(active,5),rows};}
function apply(part,actionResults,decisions){
  return Object.fromEntries(STUDY_SCENARIOS.map(([scenario])=>{
    const byAction=Object.fromEntries(ROBUST_ACTIONS.map(a=>[a,new Map(actionResults[a][scenario].rows.map(r=>[r.id,r]))]));
    const rows=controls[part].AGY_NATIVE[scenario].rows.map(r=>{
      const d=decisions.get(r.id);assert.ok(d);
      if(d.action!=='WAIT')return {...byAction[d.action].get(r.id),valueDecision:d};
      return {id:r.id,mint:r.mint,symbol:r.symbol,opportunityAt:r.signalAt,signalAt:r.signalAt,day:r.day,
        captureEnd:r.captureEnd,solUsd:r.solUsd,solAssumed:r.solAssumed,status:'SKIP',stakeUsd:0,at:r.signalAt,pnl:0,ret:null,bound:0,
        valueDecision:d,reason:d.reason};
    });return [scenario,summarize(rows)];
  }));
}
function decide(config,labels,part){return new Map(controls[part].AGY_NATIVE.base.rows.map(r=>[r.id,robustDecisionV20(config,labels,signals.get(r.id))]));}
const actionResults={train:actions('train',parent.trainEnd)},labels=robustLabelsV20(actionResults.train,signals);
const ranking=ROBUST_CONFIGS.map(config=>{
  const decisions=decide(config,labels,'train'),results=apply('train',actionResults.train,decisions),s=results.base.summary;
  return {config,decisions,results,enough:s.closed>=10&&s.days>=3,score:Math.min(...Object.values(results).map(r=>r.summary.conservativePnl))};
}).sort((a,b)=>Number(b.enough)-Number(a.enough)||b.score-a.score||b.results.base.summary.closed-a.results.base.summary.closed);
// Always retain a deterministic diagnostic primary; no-trade can never pass.
const primary=ranking[0],selected=primary.config,trainingPassed=studyTrainingPassed(primary,controls.train);
const selection={generatedAt:new Date().toISOString(),hashes,selected,trainingPassed,liveAllowed:false,cumulativeHypotheses:82,
  status:trainingPassed?'HISTORICAL_SCREEN_PASSED':'TRAINING_REJECTED',
  ranking:ranking.map(r=>({config:r.config,score:r.score,enough:r.enough,results:compactStudy(r.results)}))};
writeFileSync(`${out}-selection.json`,JSON.stringify(selection,null,2),{flag:'wx'});
const results={train:primary.results},decisions={train:Object.fromEntries(primary.decisions)};
for(const [part,end]of [['audit',parent.historicalEnd],['catchup',snapshot.cutoff]]){
  actionResults[part]=actions(part,end);
  const extra=robustLabelsV20(actionResults[part],signals);
  for(const a of ROBUST_ACTIONS)labels[a].push(...extra[a]);
  // Strict availableAt<signal.at filtering prevents later labels entering earlier decisions.
  const choices=decide(selected,labels,part);results[part]=apply(part,actionResults[part],choices);decisions[part]=Object.fromEntries(choices);
}
assert.deepEqual(Object.fromEntries(decide(selected,labels,'train')),decisions.train,'Future data changed historical choices');
assert.deepEqual(Object.fromEntries(decide(selected,labels,'audit')),decisions.audit,'Catch-up changed audit choices');
const cumulative=Object.fromEntries(STUDY_SCENARIOS.map(([scenario])=>[scenario,summarize(Object.values(results).flatMap(r=>r[scenario].rows))]));
const cumulativeControls=Object.fromEntries(['AGY_NATIVE','AGY_REFERENCE'].map(p=>[p,Object.fromEntries(STUDY_SCENARIOS.map(([s])=>
  [s,summarize(Object.values(controls).flatMap(c=>c[p][s].rows))]))]));
const hourCounts={};for(const r of cumulative.base.rows){const h=new Date(r.opportunityAt+7*3600000).getUTCHours();
  const b=hourCounts[h]??={opportunities:0,entries:0,closed:0,wins:0,losses:0,unknown:0,knownPnl:0};
  b.opportunities++;if(r.status!=='SKIP'){b.entries++;b.closed+=Number(r.status==='CLOSED');b.wins+=Number(r.status==='CLOSED'&&r.pnl>0);
    b.losses+=Number(r.status==='CLOSED'&&r.pnl<=0);b.unknown+=Number(r.pnl===null);b.knownPnl+=r.pnl??0;}}
for(const [p,h]of Object.entries(hashes))assert.equal(studyHash(p),h);
const report={...selection,results,decisions,cumulative,cumulativeControls,hourCounts,
  counts:{train:54,audit:29,catchup:6},dataMode:'EXISTING_DATA_ONLY',
  caveats:['Historical periods reused; not independent confirmation.', 'Cumulative portfolio never resets at partition boundaries.',
    'Hour counts are descriptive, not an optimized clock-based schedule.', 'Unknown is a risk proxy, not realized PnL.']};
writeFileSync(`${out}-results.json`,JSON.stringify(report),{flag:'wx'});
writeFileSync(`${out}-summary.json`,JSON.stringify({...report,decisions:undefined,
  results:Object.fromEntries(Object.entries(results).map(([k,v])=>[k,compactStudy(v)])),cumulative:compactStudy(cumulative),
  cumulativeControls:Object.fromEntries(Object.entries(cumulativeControls).map(([k,v])=>[k,compactStudy(v)]))},null,2),{flag:'wx'});
console.log(JSON.stringify({selected,trainingPassed,ranking:selection.ranking.map(r=>({config:r.config,score:r.score,base:r.results.base.summary})),
  results:Object.fromEntries(Object.entries(results).map(([p,r])=>[p,Object.fromEntries(Object.entries(r).map(([s,v])=>[s,v.summary]))])),
  cumulative:compactStudy(cumulative),hourCounts}));
