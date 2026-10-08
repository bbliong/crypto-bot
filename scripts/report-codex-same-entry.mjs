import {readFileSync,writeFileSync} from 'node:fs';
import {EXIT_COMPARATORS,commonCohort,outcomeRows,exitStats,pairedExitDifference} from './codex-same-entry-analysis.mjs';
import {simulateOnePosition} from './codex-portfolio.mjs';
import {wibHourBlock} from '../src/codex-adaptive-wave-v3.ts';
const input=JSON.parse(readFileSync('reports/codex-same-entry-replay.json'));
const trainEnd=Date.parse('2026-09-30T17:00:00Z'),validationEnd=Date.parse('2026-10-02T17:00:00Z');
const parts=[['train',-Infinity,trainEnd],['validation',trainEnd,validationEnd],['audit',validationEnd,input.split],
  ['fresh',input.split,input.cutoff],['all',-Infinity,input.cutoff]];
const scenarios=[['base',1000,.01],['delay2s',2000,.01],['feeStress',1000,.02]];
const results={};
for(const[name,start,end]of parts){
  const cohort=commonCohort(input.records,input.universe,start,end);results[name]={};
  for(const[scenario,delay,fee]of scenarios){
    const lanes={};
    for(const policy of EXIT_COMPARATORS){
      const rows=outcomeRows(cohort,policy,delay,fee,end);
      lanes[policy]={summary:exitStats(rows),portfolio:simulateOnePosition(rows,5),rows};
    }
    for(const policy of EXIT_COMPARATORS.filter(p=>p.startsWith('CODEX')))
      lanes[policy].paired=Object.fromEntries(['AGY_NATIVE','AGY_REFERENCE'].map(b=>[b,pairedExitDifference(lanes[policy].rows,lanes[b].rows)]));
    results[name][scenario]=lanes;
  }
}
const train=results.train.base;
const comparator=['AGY_NATIVE','AGY_REFERENCE'].sort((a,b)=>train[b].summary.conservativePnl-train[a].summary.conservativePnl)[0];
const ranking=EXIT_COMPARATORS.filter(p=>p.startsWith('CODEX')).map(policy=>{
  const v=train[policy],enough=v.summary.closed>=30&&v.summary.days>=3;
  const passed=enough&&v.summary.conservativePnl>0&&v.summary.profitFactor>=1.2&&
    ['AGY_NATIVE','AGY_REFERENCE'].every(p=>v.paired[p].bootstrapMeanDifferenceLow>0)&&
    ['delay2s','feeStress'].every(s=>results.train[s][policy].summary.conservativePnl>0);
  return {policy,summary:v.summary,paired:v.paired,enough,passed,rankScore:v.paired[comparator].bootstrapMeanDifferenceLow};
}).sort((a,b)=>(b.enough-a.enough)||((b.rankScore??-Infinity)-(a.rankScore??-Infinity))||b.summary.conservativePnl-a.summary.conservativePnl);
const selected=(ranking.find(x=>x.passed)??ranking[0]).policy;
const trainPassed=ranking.find(x=>x.policy===selected).passed;
const fresh=results.fresh.base[selected];
const freshPassed=trainPassed&&fresh.summary.closed>=30&&fresh.summary.unknown===0&&
  ['base','delay2s','feeStress'].every(s=>{
    const c=results.fresh[s][selected];return c.summary.conservativePnl>0&&c.summary.unknown===0&&
      ['AGY_NATIVE','AGY_REFERENCE'].every(b=>{const base=results.fresh[s][b];
        return c.paired[b].bothKnown>=30&&base.summary.unknown===0&&c.paired[b].bootstrapMeanDifferenceLow>0&&
          c.summary.worstPct>=base.summary.worstPct&&c.summary.eventBoundDrawdown<=base.summary.eventBoundDrawdown;});
  });
const cells=[];
for(const[dimension,values,key]of [['hour',[0,4,8,12,16,20],r=>wibHourBlock(r.signalAt)],
  ['regime',['DEFENSIVE','TREND','PULLBACK'],r=>r.entryRegime]])for(const value of values){
  const lanes=Object.fromEntries(EXIT_COMPARATORS.map(p=>[p,exitStats(train[p].rows.filter(r=>key(r)===value))]));
  const context=lanes.CODEX_CONTEXT;
  const bestTraining=EXIT_COMPARATORS.filter(p=>p.startsWith('CODEX')).sort((a,b)=>lanes[b].conservativePnl-lanes[a].conservativePnl)[0];
  cells.push({dimension,value,lanes,bestTrainingOnly:context.signals?bestTraining:null,
    enoughForExploration:context.mints>=20&&context.days>=3,note:'Descriptive training cell; not an enabled clock override.'});
}
const report={generatedAt:new Date().toISOString(),protocol:'docs/CODEX_SAME_ENTRY_EXIT_PROTOCOL.md',fingerprint:input.fingerprint,
  hashes:input.hashes,split:new Date(input.split).toISOString(),cutoff:new Date(input.cutoff).toISOString(),
  parityChecks:input.parityChecks,buyParityChecks:input.buyParityChecks,
  counts:{historicalSignals:input.records.filter(r=>!r.fresh).length,freshSignals:input.records.filter(r=>r.fresh).length,
    freshDetails:input.universe.filter(s=>s.start>=input.split).length},
  selected,trainingComparator:comparator,trainingPassed:trainPassed,freshPassed,
  status:!trainPassed?'TRAINING_REJECTED':!freshPassed?'INSUFFICIENT_OR_FAILED_FRESH_EVIDENCE':'PROMISING_REQUIRES_FORWARD_VALIDATION',
  liveAllowed:false,ranking,cells,results,caveats:[...input.caveats,
    'All policies use exactly the same cohort and modeled buy within a scenario. Independent event returns are not portfolio performance.',
    'Differences of conservative bounds are NOT rigorous bounds on unknown paired improvements. Both-known paired results are shown separately.',
    'Bootstrap bands are block-resampling diagnostics on a small, previously studied historical sample, not proof of live superiority.',
    'Training cell winners are exploratory. No clock switch was chosen on validation/audit/fresh outcomes.',
    'Fresh <30 closed cases is insufficient evidence, even if every observed case happens to win.']};
writeFileSync('reports/codex-same-entry-comparison.json',JSON.stringify(report,null,2));
const small={...report,results:Object.fromEntries(Object.entries(results).map(([part,scenarios])=>[part,
  Object.fromEntries(Object.entries(scenarios).map(([scenario,lanes])=>[scenario,
    Object.fromEntries(Object.entries(lanes).map(([p,x])=>[p,{...x,rows:undefined,portfolio:{...x.portfolio,selectedIds:undefined}}]))]))]))};
writeFileSync('reports/codex-same-entry-summary.json',JSON.stringify(small,null,2));
console.log(JSON.stringify({status:report.status,selected,trainingPassed:trainPassed,counts:report.counts,
  results:Object.fromEntries(Object.entries(results).map(([p,x])=>[p,Object.fromEntries(Object.entries(x.base).map(([k,v])=>[k,v.summary]))]))}));
