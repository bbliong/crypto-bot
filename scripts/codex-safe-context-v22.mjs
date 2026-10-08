// Independent Codex research lane. No live settings or order APIs.
import {assessMomentumAggressiveSafeEntry,assessMomentumAggressiveExit,MOMENTUM_AGGRESSIVE_SAFE_RULES,createMomentumPosition} from '../src/momentum-strategy.ts';
import {assessHolderDistribution} from '../src/research-simulation.ts';
import {replayAdaptiveTrade} from './codex-adaptive-engine.mjs';
import {flowWaveNetReturn} from '../src/codex-flow-wave-v2.ts';
import {asOf,firstAfter} from './guarded-wave-replay-core.mjs';
export const SAFE_CONTEXT_CONFIGS=[0,500].map(confirmMs=>({id:`SAFE_CONTEXT_${confirmMs}`,confirmMs}));
const finite=Number.isFinite;
export function contextModeV22(f){
  if(!f||f.majorSell||f.devSell30>=25||(finite(f.collapse1s)&&f.collapse1s<=-8))return 'DEFEND';
  if(!f.ready||!f.holderFresh||!f.devFresh||!f.countFresh||!finite(f.sigma1)||f.sigma1>6||
    !finite(f.buy5)||!finite(f.return2)||f.return2<=0||f.buy5<.6)return 'WAIT';
  return f.historySec>=20&&f.buy2>=.7&&f.buy5>=.7&&f.efficiency20>=.6&&f.sigma1<=2?'RUNNER':'SCALP';
}
export function safeSignalsV22(session,prepared,sol){
  const signals=[],done=new Set(),arms=new Map();let ti=0;const tape=[];
  for(const f of prepared.frames){
    if(f.at>session.start+60000)break;
    while(ti<prepared.ticks.length&&prepared.ticks[ti].observedAt<=f.at)tape.push(prepared.ticks[ti++]);
    const quality=f.holderFresh&&f.devFresh&&f.countFresh&&f.at-f.priceAt<=750&&
      [f.holders,f.top1,f.top5,f.dev].every(finite);
    const allowed=quality&&assessMomentumAggressiveSafeEntry(tape,f.at,
      assessHolderDistribution(f.holders,f.top1,f.top5,f.dev),f.dev,undefined,false,finite(f.buy20)?f.buy20*100:null).allowed;
    const spot=asOf(sol,f.at),known=spot&&f.at-spot.at<=120000,solUsd=known?spot.usd:120,mode=contextModeV22(f);
    const make=lane=>({id:`${session.id}:${lane}`,sessionId:session.id,mint:session.mint,symbol:session.symbol,source:session.source,
      lane,at:f.at,price:f.price,solUsd,solAssumed:!known,captureEnd:prepared.end,mode,
      features:{mc:f.mc,age:f.tokenAgeSec,return5:f.return5,return2:f.return2,buy5:f.buy5,buy20:f.buy20,
        sigma:f.sigma1,efficiency:f.efficiency20,top1:f.top1,dev:f.dev,buyers:f.buyers,buyUsd:f.buyUsd}});
    if(allowed&&!done.has('SAFE_NATIVE')){signals.push(make('SAFE_NATIVE'));done.add('SAFE_NATIVE');}
    const eligible=allowed&&['SCALP','RUNNER'].includes(mode)&&flowWaveNetReturn(5,solUsd,1,1)>=-3.5;
    for(const c of SAFE_CONTEXT_CONFIGS){
      if(done.has(c.id))continue;
      if(!eligible){arms.delete(c.id);continue;}
      if(c.confirmMs){
        const arm=arms.get(c.id);if(!arm){arms.set(c.id,{at:f.at,tick:f.tickId});continue;}
        if(f.at-arm.at<c.confirmMs||f.tickId===arm.tick)continue;
      }
      signals.push(make(c.id));done.add(c.id);
    }
  }return signals;
}
export function createContextV22(at,net,f){
  const mode=contextModeV22(f);return {openedAt:at,peak:net,floor:-Infinity,mode,candidate:mode,candidateAt:at,
    lastTick:null,weakAt:null,switches:0,modesSeen:[mode]};
}
export function assessContextV22(s,f,net){
  if(!finite(net)||!finite(f.price)||f.price<=0)return 'INVALID_VALUATION';
  const next=contextModeV22(f);
  if(next==='DEFEND')return 'DANGER';
  if(net<=-6)return 'HARD_NET_RISK';
  if(f.at-f.priceAt>10000)return 'PRICE_GAP_10S';
  const fresh=f.priceAt>=s.openedAt&&f.at-f.priceAt<=750,newTick=f.tickId!==s.lastTick;
  if(fresh)s.peak=Math.max(s.peak,net);
  if(next!==s.candidate){s.candidate=next;s.candidateAt=f.at;}
  else if(fresh&&newTick&&f.at-s.candidateAt>=1000&&s.mode!==next){
    s.mode=next;s.switches++;if(!s.modesSeen.includes(next))s.modesSeen.push(next);
  }
  const strong=s.mode==='RUNNER'&&next==='RUNNER',trail=strong?Math.min(7,Math.max(3,2*f.sigma1)):3;
  if(s.peak>=4)s.floor=Math.max(s.floor,.5);
  if(s.peak>=8)s.floor=Math.max(s.floor,1,(100+s.peak)*(1-trail/100)-100);
  if(net<=s.floor)return 'MONOTONE_NET_FLOOR';
  const weak=fresh&&f.buy5!=null&&f.buy5<=.4&&f.return2<0&&f.sellUsd>=150&&f.sellers>=3;
  if(!weak)s.weakAt=null;else if(newTick){s.weakAt??=f.at;if(f.at-s.weakAt>=500)return 'FLOW_REVERSAL';}
  if(fresh&&newTick)s.lastTick=f.tickId;
  const held=f.at-s.openedAt;
  if(held>=15000&&!strong)return 'SCALP_TIME_LIMIT';
  if(held>=45000)return 'ABSOLUTE_TIME_LIMIT';
  return null;
}
export function evaluateSafeV22(signal,prepared,exitMode,options){
  if(!['CONTEXT','SAFE_NATIVE'].includes(exitMode))throw Error('Invalid exit mode');
  const buy=firstAfter(prepared.ticks,signal.at+options.delayMs,Math.min(prepared.end,signal.at+options.delayMs+2000));
  const exitController=exitMode==='CONTEXT'?{create:createContextV22,assess:assessContextV22}:{
    create:at=>({position:createMomentumPosition(at,buy.priceUsd,buy.occurredAt),lastTick:null}),
    assess:(s,f)=>{if(f.tickId===s.lastTick)return null;s.lastTick=f.tickId;
      const tape=prepared.ticks.slice(0,f.tickCount),t=tape.at(-1);return t?assessMomentumAggressiveExit(s.position,t,tape,MOMENTUM_AGGRESSIVE_SAFE_RULES)?.reason??null:null;}
  };
  return replayAdaptiveTrade({...signal,lane:'AGY_NATIVE'},prepared,{...options,exitController});
}
