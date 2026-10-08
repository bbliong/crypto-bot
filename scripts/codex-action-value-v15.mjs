import {fitEvidenceV8,assessEvidenceV8,availableEvidenceV8} from './codex-evidence-wave-v8.mjs';
export const VALUE_ACTIONS=[
  {id:'DIRECT_PEAK',waitMs:0,check:'FULL'},
  {id:'FULL750_PEAK',waitMs:750,check:'FULL'},
  {id:'FULL1500_PEAK',waitMs:1500,check:'FULL'}
];
export const VALUE_CONFIGS=['FLOW','SAFETY'].flatMap(features=>[1,2].map(depth=>({id:`ACTION_VALUE_${features}_D${depth}`,features,depth})));
export function fitActionHeadsV15(config,labels,asOf){
  if(!VALUE_CONFIGS.some(c=>c.id===config.id&&c.features===config.features&&c.depth===config.depth))throw new Error('Invalid frozen action learner');
  return Object.fromEntries(VALUE_ACTIONS.map(a=>[a.id,fitEvidenceV8(config,availableEvidenceV8(labels[a.id]??[],asOf))]));
}
export function chooseActionV15(heads,opportunity){
  const predictions=VALUE_ACTIONS.map(a=>({action:a.id,...assessEvidenceV8(heads[a.id]??null,opportunity)}));
  const ranked=predictions.filter(p=>p.allowed).sort((a,b)=>b.expectedPnl-a.expectedPnl);
  return {at:opportunity.at,action:ranked[0]?.action??'WAIT',expectedPnl:ranked[0]?.expectedPnl??null,predictions,
    reason:ranked.length?'POSITIVE_PAST_ACTION_VALUE':'NO_POSITIVE_PAST_ACTION_VALUE'};
}
export function prequentialActionsV15(config,labels,opportunities){
  return [...opportunities].sort((a,b)=>a.at-b.at).map(o=>({id:o.id,...chooseActionV15(fitActionHeadsV15(config,labels,o.at),o)}));
}
export function actionLabelsV15(actionResults,signals){
  return Object.fromEntries(VALUE_ACTIONS.map(a=>[a.id,actionResults[a.id].base.rows.map(r=>({
    id:r.id,mint:r.mint,signalAt:r.opportunityAt??signals.get(r.id).at,
    availableAt:r.at??r.captureEnd,target:r.pnl??r.bound,features:signals.get(r.id).features,
    unknownProxy:r.pnl===null,status:r.status
  }))]));
}
