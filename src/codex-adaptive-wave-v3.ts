/** Codex-only research controller. No broker, collector, network, or wallet dependency. */
import type {FlowWaveFeatures} from './codex-flow-wave-v2.js';
export const CODEX_ADAPTIVE_V3='codex-adaptive-wave-v3';
export type AdaptiveMode='WAIT'|'DEFEND'|'IMPULSE'|'TREND'|'RECLAIM';
export type AdaptiveFrame=FlowWaveFeatures & {at:number;price:number;priceAt:number;tickId:string;
  efficiency20:number;sigma1:number;sellUsd:number;sellers:number;collapse1s:number|null};
const finite=(n:unknown):n is number=>typeof n==='number'&&Number.isFinite(n);
const inRange=(n:unknown,lo:number,hi:number):n is number=>finite(n)&&n>=lo&&n<=hi;
export function classifyCodexRegime(f:AdaptiveFrame,openingNet:number):{mode:AdaptiveMode;reason:string}{
  if(f.devSell30>=25||f.majorSell||((f.collapse1s??0)<=-8))return {mode:'DEFEND',reason:'DUMP_EVIDENCE'};
  if(!f.ready||!f.holderFresh||!f.devFresh||!f.countFresh||!inRange(f.at-f.priceAt,0,750)||
    !inRange(f.historySec,7,Infinity)||!inRange(openingNet,-4,0))return {mode:'WAIT',reason:'DATA_OR_COST'};
  if(!inRange(f.mc,10000,100000)||!inRange(f.tokenAgeSec,60,Infinity)||!inRange(f.holders,100,Infinity)||
    !inRange(f.top1,0,8)||!inRange(f.top5,f.top1??0,25)||!inRange(f.dev,0,2.5)||!inRange(f.devSell30,0,25)||
    !inRange(f.topBuyer,0,.5)||!inRange(f.return2,Number.EPSILON,Infinity)||!inRange(f.drawdown5,0,2.5)||
    !inRange(f.drawdown10,0,15)||!inRange(f.buy5,0,1)||!inRange(f.buy2,0,1)||
    !inRange(f.sigma1,0,Infinity)||!inRange(f.efficiency20,0,1)||!inRange(f.trades,5,Infinity))
    return {mode:'WAIT',reason:'QUALITY'};
  if(f.historySec>=22&&f.peakBeforeTrough&&inRange(f.rebound10,2,5)&&f.drawdown10<=8&&f.aboveWeightedPrice&&
    inRange(f.return5,0,8)&&f.buy2>=.8&&f.buy5>=.65&&inRange(f.buy20,.55,1)&&f.buyers>=4&&f.buyUsd>=500)
    return {mode:'RECLAIM',reason:'CONTROLLED_RECOVERY'};
  if(f.historySec>=22&&inRange(f.return5,.5,10)&&inRange(f.buy20,.68,1)&&f.buy5>=.65&&f.buy2>=.6&&
    f.buyers>=4&&f.buyUsd>=400&&f.efficiency20>=.55)
    return {mode:'TREND',reason:'PERSISTENT_DISTRIBUTED_BUY'};
  if(inRange(f.return5,1,8)&&f.buy5>=.75&&f.buy2>=.7&&f.buyers>=5&&f.buyUsd>=500&&f.topBuyer<=.35&&f.efficiency20>=.45)
    return {mode:'IMPULSE',reason:'EARLY_DISTRIBUTED_BUY'};
  return {mode:'WAIT',reason:'CHOP_EXHAUSTION_OR_NO_SETUP'};
}
export type AdaptivePosition={openedAt:number;mode:AdaptiveMode;modeCandidate:AdaptiveMode;candidateAt:number;
  peak:number;floor:number;hardFloor:number;maxHoldSec:number;weakAt:number|null;lastTick:string|null};
export function createCodexAdaptivePosition(at:number,mode:AdaptiveMode,openingNet:number):AdaptivePosition{
  return {openedAt:at,mode,modeCandidate:mode,candidateAt:at,peak:openingNet,floor:-Infinity,
    hardFloor:Math.max(-8,openingNet-4),maxHoldSec:mode==='TREND'?90:45,weakAt:null,lastTick:null};
}
/** A request to exit, never a claim of a fill. Peak and protective floor only ratchet upwards. */
export function assessCodexAdaptiveExit(s:AdaptivePosition,f:AdaptiveFrame,net:number,openingNet:number){
  if(!finite(net))return 'NET_VALUE_UNKNOWN';
  if(f.devSell30>=25||(f.majorSell&&(f.return2??0)<=0)||(f.collapse1s??0)<=-8)return 'DANGER_EXIT';
  if(f.at-f.priceAt>10000)return 'PRICE_GAP';
  s.peak=Math.max(s.peak,net);
  if(net<=s.hardFloor)return 'NET_RISK';
  const next=classifyCodexRegime(f,openingNet).mode;
  if(next!==s.modeCandidate){s.modeCandidate=next;s.candidateAt=f.at;}
  else if(f.at-s.candidateAt>=1000&&f.tickId!==s.lastTick&&next!=='WAIT'&&next!=='DEFEND')s.mode=next;
  const weak=(f.buy5??0)<.5&&(f.return2??0)<=0;
  if(!weak)s.weakAt=null;
  else if(f.tickId!==s.lastTick){
    s.weakAt??=f.at;
    if(f.at-s.weakAt>=500&&f.sellUsd>=150&&f.sellers>=3)return 'FLOW_REVERSAL';
  }
  s.lastTick=f.tickId;
  const strong=s.mode==='TREND'&&next==='TREND';
  const trail=Math.min(strong?8:5,Math.max(3,f.sigma1*(strong?1.8:1.2)));
  if(s.peak>=4)s.floor=Math.max(s.floor,.5);
  if(s.peak>=8)s.floor=Math.max(s.floor,2,(100+s.peak)*(1-trail/100)-100);
  if(weak&&s.peak>=4)s.floor=Math.max(s.floor,(100+s.peak)*.97-100);
  if(net<=s.floor)return 'MONOTONE_PROFIT_FLOOR';
  if(f.at-s.openedAt>=15000&&s.peak<2&&weak)return 'STAGNATION';
  if(f.at-s.openedAt>=s.maxHoldSec*1000)return 'TIME_LIMIT';
  return null;
}
export const wibHourBlock=(at:number)=>Math.floor(new Date(at+7*3600000).getUTCHours()/4)*4;
export type ShadowOutcome={id:string;mint:string;mode:AdaptiveMode;signalAt:number;availableAt:number;
  returnPct:number;unknown:boolean};
/** Statistical gate is heuristic and paper-only, not a calibrated probability of profit. */
export function assessCodexHourEvidence(history:ShadowOutcome[],now:number,mode:AdaptiveMode){
  const seen=new Set<string>();
  const rows=history.filter(r=>r.availableAt<now&&r.signalAt>=now-7*86400000&&r.mode===mode)
    .sort((a,b)=>b.signalAt-a.signalAt).filter(r=>{if(seen.has(r.mint))return false;seen.add(r.mint);return true;});
  const stats=(xs:ShadowOutcome[])=>{
    const values=xs.map(r=>Math.max(-100,Math.min(100,r.returnPct))),n=xs.length;
    const mean=n?values.reduce((s,x)=>s+x,0)/n:0;
    const variance=n>1?values.reduce((s,x)=>s+(x-mean)**2,0)/(n-1):Infinity;
    return {n,days:new Set(xs.map(r=>new Date(r.signalAt+7*3600000).toISOString().slice(0,10))).size,
      mean,se:Math.sqrt(variance/Math.max(1,n)),unknownRate:n?xs.filter(r=>r.unknown).length/n:1};
  };
  const global=stats(rows),local=stats(rows.filter(r=>wibHourBlock(r.signalAt)===wibHourBlock(now)));
  const localReady=local.n>=20&&local.days>=3,weight=localReady?local.n/(local.n+40):0;
  const mean=global.mean*(1-weight)+local.mean*weight;
  const se=weight?Math.max(global.se,local.se):global.se;
  const lowerScore=Number.isFinite(se)?mean-1.96*se:null;
  const allowed=global.n>=20&&global.days>=3&&global.unknownRate<=.05&&(!localReady||local.unknownRate<=.05)&&
    lowerScore!==null&&lowerScore>0;
  return {allowed,hourBlockWib:wibHourBlock(now),mode,global,local,localWeight:weight,lowerScore,
    reason:allowed?'POSITIVE_PAST_EVIDENCE':global.n<20||global.days<3?'INSUFFICIENT_PAST_EVIDENCE':'NO_POSITIVE_NET_EDGE'};
}
