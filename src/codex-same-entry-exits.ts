/** Research-only exit policies. Entry, quantity, fees and fills belong to the shared harness. */
import type {AdaptiveFrame} from './codex-adaptive-wave-v3.js';
export type ExitMode='DEFENSIVE'|'TREND'|'PULLBACK';
export type ExitPolicy=ExitMode|'CONTEXT';
export const SAME_ENTRY_POLICIES:readonly ExitPolicy[]=Object.freeze(['DEFENSIVE','TREND','PULLBACK','CONTEXT']);
const finite=(n:unknown):n is number=>typeof n==='number'&&Number.isFinite(n);
const between=(n:unknown,lo:number,hi:number)=>finite(n)&&n>=lo&&n<=hi;
export function supportedPullback(f:AdaptiveFrame){
  return f.historySec>=20&&between(f.buy20,.65,1)&&between(f.drawdown5,0,4)&&
    between(f.buyers,4,Infinity)&&between(f.topBuyer,0,.5)&&between(f.sigma1,0,8)&&
    !f.majorSell&&between(f.devSell30,0,25)&&f.devFresh&&f.holderFresh;
}
export function chooseExitMode(f:AdaptiveFrame|undefined):ExitMode{
  if(!f||!f.ready||!f.holderFresh||!f.devFresh||f.majorSell||!between(f.devSell30,0,25)||f.devSell30>=25)return 'DEFENSIVE';
  if(supportedPullback(f)&&between(f.drawdown5,1,4)&&((f.peakBeforeTrough&&f.rebound10>=1)||between(f.buy2,.45,1)))return 'PULLBACK';
  if(f.historySec>=20&&between(f.buy20,.68,1)&&between(f.buy5,.65,1)&&between(f.efficiency20,.45,1)&&
    finite(f.return2)&&f.return2>0)return 'TREND';
  return 'DEFENSIVE';
}
export type SameEntryExitState={policy:ExitPolicy;openedAt:number;mode:ExitMode;candidate:ExitMode;candidateAt:number;
  peak:number;floor:number;hardNet:number;maxHoldMs:number;weakAt:number|null;weakTicks:number;lastTick:string|null;
  switches:number;graceEpisodes:number;graceActive:boolean;graceUntil:number|null};
export function createSameEntryExit(policy:ExitPolicy,openedAt:number,initialNet:number,frame?:AdaptiveFrame):SameEntryExitState{
  const mode=policy==='CONTEXT'?chooseExitMode(frame):policy;
  return {policy,openedAt,mode,candidate:mode,candidateAt:openedAt,peak:initialNet,floor:-Infinity,hardNet:-6,
    maxHoldMs:mode==='DEFENSIVE'?45000:90000,weakAt:null,weakTicks:0,lastTick:null,switches:0,graceEpisodes:0,graceActive:false,graceUntil:null};
}
/** Return an exit request only. Risk/floor always override a recovery grace period. */
export function assessSameEntryExit(s:SameEntryExitState,f:AdaptiveFrame,net:number):string|null{
  if(!finite(f.at)||!finite(f.priceAt)||!finite(f.price)||f.price<=0||!finite(net))return 'INVALID_VALUATION';
  if(f.devSell30>=25||(f.majorSell&&(f.return2??0)<=0)||(f.collapse1s??0)<=-8)return 'DANGER';
  if(f.at-f.priceAt>10000)return 'PRICE_GAP';
  s.peak=Math.max(s.peak,net);
  if(net<=s.hardNet)return 'HARD_NET_RISK';
  const newTick=f.tickId!==s.lastTick,fresh=f.at>=f.priceAt&&f.at-f.priceAt<=750;
  if(s.policy==='CONTEXT'&&fresh){
    const next=chooseExitMode(f);
    if(next!==s.candidate){s.candidate=next;s.candidateAt=f.at;}
    else if(newTick&&next!==s.mode&&f.at-s.candidateAt>=1000){s.mode=next;s.switches++;}
  }
  const defensive=s.mode==='DEFENSIVE';
  const sigma=finite(f.sigma1)?Math.max(0,f.sigma1):0;
  const trail=defensive?Math.max(3,Math.min(5,1.2*sigma)):Math.max(5,Math.min(8,1.8*sigma));
  if(s.peak>=(defensive?4:8))s.floor=Math.max(s.floor,defensive?1:1.5);
  if(s.peak>=(defensive?8:12))s.floor=Math.max(s.floor,(100+s.peak)*(1-trail/100)-100);
  if(net<=s.floor)return 'PROFIT_FLOOR';
  const weak=fresh&&between(f.buy5,0,.5-Number.EPSILON)&&finite(f.return2)&&f.return2<0&&f.sellUsd>=150&&f.sellers>=3;
  if(fresh&&!weak){s.weakAt=null;s.weakTicks=0;s.graceActive=false;s.graceUntil=null;}
  else if(weak&&newTick){s.weakAt??=f.at;s.weakTicks++;}
  s.lastTick=f.tickId;
  if(s.graceActive&&s.weakAt!==null){
    const limit=defensive?0:s.mode==='TREND'?2000:3000;
    s.graceUntil=Math.min(s.graceUntil??Infinity,s.weakAt+limit);
    if(f.at>=s.graceUntil)return 'PULLBACK_GRACE_EXPIRED';
  }
  if(weak&&s.weakAt!==null&&s.weakTicks>=2&&f.at-s.weakAt>=500){
    if((f.buy5??1)<=.25)return 'EXTREME_SELL_FLOW';
    const grace=defensive?0:s.mode==='TREND'?2000:3000;
    if(!grace||!supportedPullback(f)||f.at-s.weakAt>=grace)return 'FLOW_REVERSAL';
    if(!s.graceActive){s.graceEpisodes++;s.graceActive=true;s.graceUntil=s.weakAt+grace;}
  }
  if(f.at-s.openedAt>=(defensive?12000:20000)&&s.peak<2&&weak&&!s.graceActive)return 'STAGNATION';
  if(f.at-s.openedAt>=s.maxHoldMs)return 'TIME_LIMIT';
  return null;
}
