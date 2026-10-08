// Offline causal router: learn the worst modeled execution outcome, not base-only gains.
import {fitEvidenceV8,assessEvidenceV8,availableEvidenceV8} from './codex-evidence-wave-v8.mjs';
import {replayAdaptiveTrade} from './codex-adaptive-engine.mjs';
import {evaluatePeakV10} from './codex-peak-recheck-v10.mjs';
import {evaluateInvalidationV19,INVALIDATION_CONFIGS} from './codex-invalidation-v19.mjs';
export const ROBUST_ACTIONS=['NATIVE','PEAK_DIRECT','INVALIDATE_500_PRICE','INVALIDATE_1000_PRICE','PEAK_FULL1500'];
export const ROBUST_CONFIGS=['FLOW','SAFETY'].map(features=>({id:`ROBUST_${features}_D1`,features,depth:1}));
export function evaluateRobustActionV20(signal,prepared,action,options){
  if(action==='NATIVE')return replayAdaptiveTrade({...signal,lane:'AGY_NATIVE'},prepared,options);
  if(action==='PEAK_DIRECT'||action==='PEAK_FULL1500')return evaluatePeakV10(signal,prepared,{waitMs:action==='PEAK_DIRECT'?0:1500,check:'FULL'},options);
  const c=INVALIDATION_CONFIGS.find(c=>c.id===action);if(!c)throw Error('Unknown action');
  return evaluateInvalidationV19(signal,prepared,c,options);
}
export function robustLabelsV20(results,signals){
  return Object.fromEntries(ROBUST_ACTIONS.map(action=>{
    const scenarios=['base','delay2s','feeStress'].map(s=>new Map(results[action][s].rows.map(r=>[r.id,r])));
    const labels=[...scenarios[0].keys()].map(id=>{
      const rs=scenarios.map(m=>m.get(id));if(rs.some(r=>!r))throw Error('Missing scenario outcome');
      const signal=signals.get(id);if(!signal)throw Error('Missing signal');
      const targets=rs.map(r=>r.pnl??r.bound),availability=rs.map(r=>r.at??r.captureEnd);
      if(!targets.every(Number.isFinite)||!availability.every(Number.isFinite))throw Error('Invalid labels');
      return {id,mint:signal.mint,signalAt:signal.at,features:signal.features,target:Math.min(...targets),
        availableAt:Math.max(...availability),unknownProxy:rs.some(r=>r.pnl===null)};
    });
    return [action,labels];
  }));
}
export function robustDecisionV20(config,labels,signal){
  if(!ROBUST_CONFIGS.some(c=>c.id===config.id&&c.features===config.features))throw Error('Invalid router');
  const predictions=ROBUST_ACTIONS.map(action=>{
    const history=availableEvidenceV8(labels[action]??[],signal.at),model=fitEvidenceV8(config,history);
    return {action,historyN:history.length,...assessEvidenceV8(model,signal)};
  });
  const eligible=predictions.filter(p=>p.allowed).sort((a,b)=>b.expectedPnl-a.expectedPnl);
  return {at:signal.at,action:eligible[0]?.action??'WAIT',predictions,
    reason:eligible.length?'POSITIVE_PAST_WORST_SCENARIO':'NO_POSITIVE_PAST_WORST_SCENARIO'};
}
