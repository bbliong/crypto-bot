import {asOf} from './guarded-wave-replay-core.mjs';
import {entryQualityV5} from './codex-engineering-v5.mjs';
export const V6_ENTRIES=['MATURE_TREND','MATURE_RECLAIM'];
export function setupV6(f,mode){
  if(!V6_ENTRIES.includes(mode))throw new Error(`Unknown independent mode ${mode}`);
  if(!entryQualityV5(f)||f.tokenAgeSec<300||f.devSell30>=25||
    (f.majorSell&&(f.return2??0)<=0)||(f.collapse1s??0)<=-8)return false;
  if(mode==='MATURE_TREND')return Number.isFinite(f.return5)&&f.return5>=.5&&f.return5<=10;
  return f.historySec>=20&&f.peakBeforeTrough&&f.rebound10>=1&&f.rebound10<=4&&f.drawdown10>=2&&f.drawdown10<=8&&
    Number.isFinite(f.return5)&&f.return5>=-3&&f.return5<=8&&f.buy5>=.65;
}
// No AGY signal or future token survival is required or consulted.
export function signalsV6(session,prepared,sol){
  const arms=new Map(),done=new Set(),signals=[];
  for(const f of prepared.frames){
    if(f.at>session.start+60000)break;
    for(const mode of V6_ENTRIES){
      if(done.has(mode))continue;
      if(!setupV6(f,mode)){arms.delete(mode);continue;}
      const arm=arms.get(mode);
      if(!arm){arms.set(mode,{at:f.at,tick:f.tickId});continue;}
      if(f.at-arm.at<500||f.tickId===arm.tick)continue;
      done.add(mode);const spot=asOf(sol,f.at),known=spot&&f.at-spot.at<=120000;
      signals.push({id:`${session.id}:${mode}`,sessionId:session.id,mint:session.mint,symbol:session.symbol,source:session.source,
        mode:'AGY',lane:mode,at:f.at,price:f.price,solUsd:known?spot.usd:120,solAssumed:!known,captureEnd:prepared.end,
        features:{mc:f.mc,age:f.tokenAgeSec,return5:f.return5,buy5:f.buy5,buy20:f.buy20,buyers:f.buyers,buyUsd:f.buyUsd,
          top1:f.top1,dev:f.dev,efficiency:f.efficiency20,sigma:f.sigma1}});
    }
  }
  return signals;
}
