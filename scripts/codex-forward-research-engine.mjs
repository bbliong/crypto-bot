// Stateless cumulative evaluation; incremental journal ownership is in the runner.
import {replayAdaptiveTrade} from './codex-adaptive-engine.mjs';
import {evaluatePeakV10} from './codex-peak-recheck-v10.mjs';
import {attachBreadthV14} from './codex-breadth-router-v14.mjs';
import {evaluateNormalizedV16} from './codex-normalized-breadth-v16.mjs';
import {VALUE_ACTIONS,chooseActionV15,actionLabelsV15} from './codex-action-value-v15.mjs';
import {onlineActionV17,forwardReplayPassedV17} from './codex-online-value-v17.mjs';
import {commonCohort,wibDay,exitStats} from './codex-same-entry-analysis.mjs';
import {STUDY_SCENARIOS} from './codex-cached-opportunity-study.mjs';
import {simulateOnePosition} from './codex-portfolio.mjs';
export const FORWARD_POLICIES=['AGY_NATIVE','AGY_REFERENCE','PEAK_RECHECK_V10','NORMALIZED_BREADTH_V16','ACTION_VALUE_FIXED_V15','ACTION_VALUE_ONLINE_V17'];
export function evaluateForwardResearch({cases,universe,contextEvents,registry,start,cutoff,seedLabels}){
  const cohort=commonCohort([...cases.values()].map(c=>c.signal),universe,start,cutoff),signalMap=new Map(cohort.map(s=>[s.id,s]));
  const contextual=attachBreadthV14(new Map(cohort.map(s=>[s.id,cases.get(s.id)])),contextEvents);
  function row(signal,o){
    if(o.at!==null&&o.at>=cutoff&&o.status!=='SKIP')o={...o,status:'PARTITION_UNKNOWN',at:null,pnl:null,ret:null};
    return {id:signal.id,mint:signal.mint,symbol:signal.symbol,opportunityAt:signal.at,signalAt:o.decisionAt??signal.at,
      day:wibDay(o.decisionAt??signal.at),captureEnd:Math.min(signal.captureEnd,cutoff),solUsd:signal.solUsd,solAssumed:signal.solAssumed,...o,
      bound:o.pnl??-(5+.000205*signal.solUsd+(o.failedSell??0)*.000105*signal.solUsd)};
  }
  const actionResults=Object.fromEntries(VALUE_ACTIONS.map(a=>[a.id,Object.fromEntries(STUDY_SCENARIOS.map(([name,delayMs,feeSide])=>[name,
    {rows:cohort.map(s=>row(s,evaluatePeakV10(s,cases.get(s.id).prepared,a,{delayMs,feeSide})))}]))]));
  const newLabels=actionLabelsV15(actionResults,signalMap),allLabels=Object.fromEntries(VALUE_ACTIONS.map(a=>[a.id,[...(seedLabels[a.id]??[]),...newLabels[a.id]]]));
  const decisions=Object.fromEntries(cohort.map(s=>[s.id,{
    fixed:chooseActionV15(registry.value.heads,s),online:onlineActionV17(registry.value.selected,allLabels,s)
  }]));
  const results=Object.fromEntries(FORWARD_POLICIES.map(policy=>[policy,Object.fromEntries(STUDY_SCENARIOS.map(([name,delayMs,feeSide])=>{
    const actionRows=Object.fromEntries(VALUE_ACTIONS.map(a=>[a.id,new Map(actionResults[a.id][name].rows.map(r=>[r.id,r]))]));
    const rows=cohort.map(signal=>{
      const p=cases.get(signal.id).prepared;
      if(policy.startsWith('AGY_'))return row(signal,replayAdaptiveTrade({...signal,lane:policy},p,{delayMs,feeSide}));
      if(policy==='PEAK_RECHECK_V10')return row(signal,evaluatePeakV10(signal,p,registry.peak.selected,{delayMs,feeSide}));
      if(policy==='NORMALIZED_BREADTH_V16')return row(signal,evaluateNormalizedV16(contextual.get(signal.id).signal,p,registry.normalized.selected,{delayMs,feeSide}));
      const d=policy==='ACTION_VALUE_FIXED_V15'?decisions[signal.id].fixed:decisions[signal.id].online;
      if(d.action==='WAIT')return row(signal,{status:'SKIP',stakeUsd:0,at:signal.at,pnl:0,ret:null,reason:d.reason,valueDecision:d});
      return {...actionRows[d.action].get(signal.id),valueDecision:d};
    });
    const active=rows.filter(r=>r.status!=='SKIP');
    return[name,{summary:{...exitStats(active),opportunities:rows.length,skips:rows.length-active.length},portfolio:simulateOnePosition(active,5),rows}];
  }))]));
  const promising=FORWARD_POLICIES.filter(p=>!p.startsWith('AGY_')&&forwardReplayPassedV17(results,p));
  return {start,cutoff,results,decisions,newLabelCounts:Object.fromEntries(VALUE_ACTIONS.map(a=>[a.id,newLabels[a.id].length])),
    cohortIds:cohort.map(s=>s.id),promising,status:promising.length?'PROMISING_FORWARD_REPLAY':'NO_VALIDATED_OUTPERFORMANCE',liveAllowed:false};
}
