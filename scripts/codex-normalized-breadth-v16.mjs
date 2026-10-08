import {evaluateBreadthV14,BREADTH_CONFIGS} from './codex-breadth-router-v14.mjs';
export const NORMALIZED_CONFIGS=BREADTH_CONFIGS.map(c=>({...c,id:c.id.replace('BREADTH','NORMALIZED_BREADTH')}));
const finite=x=>typeof x==='number'&&Number.isFinite(x);
export function previousSigmaV16(ticks,at){
  const buckets=new Map();
  for(const t of ticks)if(t.observedAt>at-22000&&t.observedAt<=at-2000&&finite(t.priceUsd)&&t.priceUsd>0)
    buckets.set(Math.floor(t.observedAt/1000),t.priceUsd);
  const prices=[...buckets.entries()].sort((a,b)=>a[0]-b[0]).map(([,p])=>p);
  const steps=prices.slice(1).map((p,i)=>100*Math.log(p/prices[i]));
  return {steps:steps.length,sigma:steps.length>=5?Math.max(.3,Math.sqrt(steps.reduce((s,r)=>s+r*r,0)/steps.length)):null};
}
export function severeShockV16(f,sigma){
  if(!finite(sigma)||sigma<=0)return false;
  const shock=(r,width)=>finite(r)&&r>-100&&r<=-8&&100*Math.log1p(r/100)/(sigma*Math.sqrt(width))<=-3;
  return shock(f.return2,2)||shock(f.collapse1s,1);
}
export function normalizedEventsV16(session,prepared){
  const events=[],past=[];let index=0,lastTick=null,last=null;
  for(const f of prepared.frames){
    while(index<prepared.ticks.length&&prepared.ticks[index].observedAt<=f.at)past.push(prepared.ticks[index++]);
    if(f.tickId===lastTick)continue;lastTick=f.tickId;
    if(!finite(f.priceAt)||f.at-f.priceAt>750||f.at<f.priceAt)continue;
    const sigma=previousSigmaV16(past,f.at),dump=severeShockV16(f,sigma.sigma),ready=!!f.ready&&sigma.sigma!==null;
    if(!ready&&!dump)continue;
    const weak=finite(f.buy5)&&finite(f.return2)&&f.buy5<.5&&f.return2<=0;
    if(last&&f.at-last.at<5000&&!dump&&last.ready===ready&&last.weak===weak&&last.dump===dump)continue;
    const e={at:f.at,mint:session.mint,ready,weak,dump,previousSigma:sigma.sigma,previousSteps:sigma.steps};events.push(e);last=e;
  }return events;
}
export function evaluateNormalizedV16(signal,prepared,config,options){
  if(!NORMALIZED_CONFIGS.some(c=>c.id===config.id&&c.dumpCap===config.dumpCap&&c.healthyAction===config.healthyAction))
    throw new Error('Invalid normalized router');
  const original=BREADTH_CONFIGS.find(c=>c.dumpCap===config.dumpCap&&c.healthyAction===config.healthyAction);
  return evaluateBreadthV14(signal,prepared,original,options);
}
