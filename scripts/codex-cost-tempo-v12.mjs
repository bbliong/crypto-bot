// Pure independent research policy. No broker, wall clock, fitting, or live writes.
import {asOf,firstAfter} from './guarded-wave-replay-core.mjs';
import {entryQualityV5} from './codex-engineering-v5.mjs';
import {flowWaveNetReturn} from '../src/codex-flow-wave-v2.ts';
import {replayAdaptiveTrade} from './codex-adaptive-engine.mjs';
import {createMomentumPosition} from '../src/momentum-strategy.ts';
import {assessPeakV10} from './codex-peak-recheck-v10.mjs';
export const TEMPO_CONFIGS=[.25,.5].flatMap(lambda=>['PEAK_CONTROL','TEMPO'].map(exitMode=>({
  id:`COST_TEMPO_${lambda}_${exitMode}`,lambda,exitMode})));
const finite=x=>typeof x==='number'&&Number.isFinite(x);
const danger=f=>f.devSell30>=25||f.majorSell||(finite(f.collapse1s)&&f.collapse1s<=-8);
export function costTempoScore(f,solUsd,lambda){
  if(![.25,.5].includes(lambda))throw new Error('Invalid frozen cost buffer');
  if(!finite(solUsd)||solUsd<=0||!finite(f.return2)||!finite(f.return5)||f.return2<=0||f.return5<=0||
    !finite(f.sigma1)||f.sigma1<0)return {edge:null};
  const opening=flowWaveNetReturn(5,solUsd,1,1,.01,.000205),double=flowWaveNetReturn(5,solUsd,1,2,.01,.000205);
  const grossBreakEven=-opening/(double-opening)*100;
  const velocity=Math.min(100*Math.log1p(f.return2/100)/2,100*Math.log1p(f.return5/100)/5);
  const horizonSec=f.sigma1>=3?3:f.sigma1>=1.5?5:8;
  const gross=100*Math.expm1(velocity*horizonSec/100),buffer=lambda*f.sigma1*Math.sqrt(horizonSec+1);
  return {edge:gross-grossBreakEven-buffer,gross,grossBreakEven,velocity,horizonSec,buffer,openingNet:opening};
}
export function tempoMode(f){
  return finite(f.buy2)&&f.buy2>=.7&&finite(f.buy5)&&f.buy5>=.7&&finite(f.efficiency20)&&f.efficiency20>=.6&&
    finite(f.return2)&&f.return2>0&&finite(f.sigma1)&&f.sigma1<=2?'RUNNER':'SCALP';
}
export function costTempoSetup(f,solUsd,lambda){
  if(!entryQualityV5(f)||danger(f)||!finite(f.return5)||f.return5<.5||f.return5>12||
    !finite(f.sigma1)||f.sigma1<0||f.sigma1>4||!finite(f.efficiency20)||f.efficiency20<.35)
    return {allowed:false,reason:'QUALITY_OR_DANGER'};
  const score=costTempoScore(f,solUsd,lambda);
  return {...score,mode:tempoMode(f),allowed:finite(score.edge)&&score.edge>=1,reason:score.edge>=1?'COST_EDGE':'INSUFFICIENT_COST_EDGE'};
}
export function signalsCostTempoV12(session,prepared,sol){
  const signals=[],arms=new Map(),done=new Set();
  for(const f of prepared.frames){
    if(f.at>session.start+60000)break;
    const spot=asOf(sol,f.at),known=spot&&f.at-spot.at<=120000,solUsd=known?spot.usd:120;
    for(const lambda of [.25,.5]){
      if(done.has(lambda))continue;
      const decision=costTempoSetup(f,solUsd,lambda);
      if(!decision.allowed){arms.delete(lambda);continue;}
      const arm=arms.get(lambda);
      if(!arm){arms.set(lambda,{at:f.at,tick:f.tickId});continue;}
      if(f.at-arm.at<500||f.tickId===arm.tick)continue;
      done.add(lambda);
      signals.push({id:`${session.id}:COST_TEMPO_${lambda}`,sessionId:session.id,mint:session.mint,symbol:session.symbol,source:session.source,
        lane:`COST_TEMPO_${lambda}`,lambda,mode:decision.mode,at:f.at,price:f.price,solUsd,solAssumed:!known,
        captureEnd:prepared.end,features:{mc:f.mc,age:f.tokenAgeSec,return5:f.return5,return2:f.return2,buy5:f.buy5,buy20:f.buy20,
          buyers:f.buyers,buyUsd:f.buyUsd,top1:f.top1,dev:f.dev,sigma:f.sigma1,efficiency:f.efficiency20},entryScore:decision});
    }
  }return signals;
}
export function createTempoState(at,net,f){
  const mode=tempoMode(f??{});
  return {openedAt:at,peak:net,floor:-Infinity,mode,candidate:mode,candidateAt:at,lastTick:null,weakAt:null,
    maxHoldMs:mode==='RUNNER'?45000:15000};
}
export function assessTempoExit(s,f,net){
  if(!finite(net)||!finite(f.price)||f.price<=0)return 'INVALID_VALUATION';
  if(danger(f))return 'DANGER';
  if(f.at-f.priceAt>10000)return 'PRICE_GAP_10S';
  if(net<=-6)return 'HARD_NET_RISK';
  const fresh=f.priceAt>=s.openedAt&&f.at-f.priceAt<=750,newTick=f.tickId!==s.lastTick;
  if(fresh)s.peak=Math.max(s.peak,net);
  const next=tempoMode(f);
  if(next!==s.candidate){s.candidate=next;s.candidateAt=f.at;}
  else if(fresh&&newTick&&f.at-s.candidateAt>=1000)s.mode=next;
  const weak=f.buy5!=null&&f.buy5<=.4&&f.return2!=null&&f.return2<0&&f.sellUsd>=150&&f.sellers>=3;
  if(!weak||!fresh)s.weakAt=null;
  else if(newTick){s.weakAt??=f.at;if(f.at-s.weakAt>=500)return 'FLOW_REVERSAL';}
  if(fresh&&newTick)s.lastTick=f.tickId;
  const strong=s.mode==='RUNNER'&&next==='RUNNER',trail=strong?Math.min(7,Math.max(3,2*f.sigma1)):3;
  if(s.peak>=4)s.floor=Math.max(s.floor,.5);
  if(s.peak>=8)s.floor=Math.max(s.floor,1,(100+s.peak)*(1-trail/100)-100);
  if(net<=s.floor)return 'MONOTONE_NET_FLOOR';
  if(f.at-s.openedAt>=10000&&s.peak<2&&f.buy5!=null&&f.buy5<.6)return 'STAGNATION';
  if(f.at-s.openedAt>=s.maxHoldMs)return 'TIME_LIMIT';
  return null;
}
export function evaluateCostTempoV12(signal,prepared,config,options){
  if(!TEMPO_CONFIGS.some(c=>c.id===config.id&&c.lambda===config.lambda&&c.exitMode===config.exitMode)||signal.lambda!==config.lambda)
    throw new Error('Invalid cost tempo configuration or signal');
  const buy=firstAfter(prepared.ticks,signal.at+options.delayMs,Math.min(prepared.end,signal.at+options.delayMs+2000));
  const exitController=config.exitMode==='TEMPO'?{
    create:(at,net,f)=>createTempoState(at,net,f),assess:(s,f,net)=>assessTempoExit(s,f,net)
  }:{create:at=>({position:createMomentumPosition(at,buy.priceUsd,buy.occurredAt),lastTick:null}),
    assess:(s,f)=>assessPeakV10(s,f,prepared.ticks)};
  return replayAdaptiveTrade({...signal,lane:'AGY_NATIVE'},prepared,{...options,exitController});
}
