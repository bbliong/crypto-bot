import {prepareFlowWaveSession} from './codex-flow-wave-engine.mjs';
import {asOf,firstAfter} from './guarded-wave-replay-core.mjs';
import {flowWaveNetReturn} from '../src/codex-flow-wave-v2.ts';
import {confirmCodexSetup} from '../src/codex-guarded-wave.ts';
import {classifyCodexRegime,createCodexAdaptivePosition,assessCodexAdaptiveExit} from '../src/codex-adaptive-wave-v3.ts';
import {assessMomentumAdaptiveWaveEntry,assessMomentumAdaptiveWaveExit,createMomentumPosition} from '../src/momentum-strategy.ts';
import {assessAdaptiveExit} from '../src/adaptive-wave.ts';
import {assessHolderDistribution} from '../src/research-simulation.ts';
export const ADAPTIVE_EXECUTION={stakeUsd:5,buySlippage:.09,sellSlippage:.14,networkSol:.000205,failedSol:.000105};
function texture(tape,at){
  const buckets=new Map();for(const t of tape)if(t.observedAt>at-20000)buckets.set(Math.floor(t.observedAt/1000),t.priceUsd);
  const ps=[...buckets.values()],steps=ps.slice(1).map((p,i)=>Math.log(p/ps[i]));
  const path=steps.reduce((s,r)=>s+Math.abs(r),0),direction=steps.reduce((s,r)=>s+r,0);
  return {efficiency20:path>0?Math.min(1,Math.abs(direction)/path):0,
    sigma1:steps.length?Math.sqrt(steps.reduce((s,r)=>s+r*r,0)/steps.length)*100:0};
}
export function prepareAdaptiveSession(data,s,sol){
  const base=prepareFlowWaveSession(data,s,sol,{entries:[]}),signals=[];
  let i=0,arm=null,armMode=null,agy=false,codex=false,lastId=null,tex={efficiency20:0,sigma1:0};
  const past=[];
  for(const f of base.frames){
    while(i<base.ticks.length&&base.ticks[i].observedAt<=f.at)past.push(base.ticks[i++]);
    if(f.tickId!==lastId){tex=texture(past,f.at);lastId=f.tickId;}
    Object.assign(f,tex,{tickCount:i});
    if(f.at>s.start+60000)continue;
    const spot=asOf(sol,f.at),known=spot&&f.at-spot.at<=120000,solUsd=known?spot.usd:120;
    const immediate=flowWaveNetReturn(5,solUsd,f.price,f.price);
    const signal=lane=>({id:`${s.id}:${lane}`,sessionId:s.id,mint:s.mint,symbol:s.symbol,source:s.source,
      lane,at:f.at,price:f.price,solUsd,solAssumed:!known,captureEnd:base.end,
      features:{mc:f.mc,age:f.tokenAgeSec,return5:f.return5,buy5:f.buy5,buy20:f.buy20,buyers:f.buyers,buyUsd:f.buyUsd,
        top1:f.top1,dev:f.dev,efficiency:tex.efficiency20,sigma:tex.sigma1}});
    // Shared data-quality adapter: not a reproduction of the collector's missing-data fallbacks.
    const quality=f.holderFresh&&f.devFresh&&f.countFresh&&f.at-f.priceAt<=750&&f.holders!=null&&f.top1!=null&&f.top5!=null&&f.dev!=null;
    if(!agy&&quality){
      const h=assessHolderDistribution(f.holders,f.top1,f.top5,f.dev);
      const a=assessMomentumAdaptiveWaveEntry(past,f.at,h,f.dev,f.top1,f.top5,f.mc,f.tokenAgeSec,f.holders);
      if(a.allowed){agy=true;signals.push({...signal('AGY_NATIVE'),mode:'AGY'},{...signal('AGY_REFERENCE'),mode:'AGY'});}
    }
    if(!codex){
      const regime=classifyCodexRegime(f,immediate),allowed=regime.mode!=='WAIT'&&regime.mode!=='DEFEND';
      if(regime.mode!==armMode){arm=null;armMode=regime.mode;}
      const c=confirmCodexSetup(arm,allowed,f.at,f.price,f.tickId);arm=c.arm;
      if(c.confirmed){codex=true;signals.push({...signal('CODEX_EVENT'),mode:regime.mode});}
    }
  }
  return {...base,signals};
}
function agyReferenceExit(p,now,net,peak,tape){
  const t5=tape.filter(t=>t.occurredAt>=now-5000&&t.occurredAt<=now),t1=t5.filter(t=>t.occurredAt>=now-1000);
  const total=t5.reduce((s,t)=>s+Math.max(0,t.usd??0),0),sell=t5.filter(t=>t.side==='sell').reduce((s,t)=>s+Math.max(0,t.usd??0),0);
  const slope=t5.length?(t5.at(-1).priceUsd/t5[0].priceUsd-1)*100/5:0;
  const collapse=t1.length?(t1.at(-1).priceUsd/t1[0].priceUsd-1)*100:null;
  return assessAdaptiveExit(now,p.openedAt,net,peak,0,collapse,total?sell/total:0,sell,
    new Set(t5.filter(t=>t.side==='sell'&&t.wallet).map(t=>t.wallet)).size,total?1-sell/total:0,slope);
}
export function replayAdaptiveTrade(signal,prepared,{delayMs=1000,feeSide=.01,exitController=null}={}){
  const c=ADAPTIVE_EXECUTION,sol=signal.solUsd,cost=c.stakeUsd+c.networkSol*sol;
  const base={delayMs,feeSide,stakeUsd:c.stakeUsd};
  const buy=firstAfter(prepared.ticks,signal.at+delayMs,Math.min(prepared.end,signal.at+delayMs+2000));
  if(!buy)return {...base,status:'BUY_UNKNOWN',at:null,pnl:null,ret:null};
  if(buy.priceUsd>signal.price/(1-c.buySlippage))return {...base,status:'BUY_FAILED',at:buy.observedAt,pnl:-c.failedSol*sol,ret:null};
  const value=p=>flowWaveNetReturn(c.stakeUsd,sol,buy.priceUsd,p,feeSide,c.networkSol);
  const initial=value(buy.priceUsd),position=createMomentumPosition(buy.observedAt,buy.priceUsd,buy.occurredAt);
  const adaptive=createCodexAdaptivePosition(buy.observedAt,signal.mode,initial);
  const custom=exitController?.create(buy.observedAt,initial,asOf(prepared.frames,buy.observedAt,'at'));
  const opened={...base,buyAt:buy.observedAt,buyPrice:buy.priceUsd,initialNet:initial,
    buyQuantity:c.stakeUsd*(1-feeSide)/buy.priceUsd};
  let request=null,peak=initial,lastTick=null;
  for(const f of prepared.frames){
    if(f.at<buy.observedAt)continue;
    const net=value(f.price);peak=Math.max(peak,net);let reason=null;
    if(exitController)reason=exitController.assess(custom,f,net);
    else if(signal.lane==='CODEX_EVENT')reason=assessCodexAdaptiveExit(adaptive,f,net,initial);
    else if(f.tickId!==lastTick){
      const tape=prepared.ticks.slice(0,f.tickCount),tick=tape.at(-1);
      if(tick.observedAt<=buy.observedAt)continue;
      if(signal.lane==='AGY_NATIVE')reason=assessMomentumAdaptiveWaveExit(position,tick,tape)?.reason??null;
      else reason=agyReferenceExit(position,tick.observedAt,net,peak,tape);
    }
    lastTick=f.tickId;
    if(reason){request={at:f.at,reason,price:f.price,net};break;}
  }
  if(!request)return {...opened,status:'SELL_UNKNOWN',at:null,pnl:null,ret:null,reason:'CAPTURE_END'};
  const exit={...opened,reason:request.reason,exitSignalAt:request.at,exitSignalReturn:request.net,
    ...(custom?{exitState:custom}:{})};
  let at=request.at,failed=0;
  while(failed<3){
    const sell=firstAfter(prepared.ticks,at+delayMs,Math.min(prepared.end,at+delayMs+2000));
    if(!sell)return {...exit,status:'SELL_UNKNOWN',at:null,pnl:null,ret:null,failedSell:failed};
    const quoted=asOf(prepared.ticks,at,'observedAt')?.priceUsd??request.price;
    if(sell.priceUsd<quoted*(1-c.sellSlippage)){failed++;at=sell.observedAt;continue;}
    const ret=value(sell.priceUsd)-failed*c.failedSol*sol/cost*100;
    return {...exit,status:'CLOSED',at:sell.observedAt,sellPrice:sell.priceUsd,ret,pnl:cost*ret/100,failedSell:failed,peakNet:peak};
  }
  return {...exit,status:'SELL_UNKNOWN',at:null,pnl:null,ret:null,failedSell:failed};
}
