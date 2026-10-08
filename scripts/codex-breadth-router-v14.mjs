import {evaluatePeakV10} from './codex-peak-recheck-v10.mjs';
export const BREADTH_CONFIGS=[.1,.2].flatMap(dumpCap=>['FAST','CHECKED'].map(healthyAction=>({
  id:`BREADTH_${dumpCap}_${healthyAction}`,dumpCap,healthyAction})));
const finite=x=>typeof x==='number'&&Number.isFinite(x);
export function breadthEventsV14(session,prepared){
  const events=[];let lastTick=null,last=null;
  for(const f of prepared.frames){
    if(f.tickId===lastTick)continue;lastTick=f.tickId;
    if(!finite(f.priceAt)||f.at-f.priceAt>750||f.at<f.priceAt)continue;
    const dump=(finite(f.return2)&&f.return2<=-8)||(finite(f.collapse1s)&&f.collapse1s<=-8);
    if(!f.ready&&!dump)continue;
    const weak=finite(f.buy5)&&finite(f.return2)&&f.buy5<.5&&f.return2<=0;
    const ready=!!f.ready;
    if(last&&f.at-last.at<5000&&!dump&&last.ready===ready&&last.weak===weak&&last.dump===dump)continue;
    const event={at:f.at,mint:session.mint,ready,weak,dump};events.push(event);last=event;
  }return events;
}
export function createBreadthCursorV14(input){
  const events=[...input].sort((a,b)=>a.at-b.at||a.mint.localeCompare(b.mint));
  let index=0,lastNow=-Infinity;const members=new Map();
  return {snapshot(now,excludeMint){
    if(!finite(now)||now<lastNow)throw new Error('Breadth snapshots must be chronological');lastNow=now;
    while(index<events.length&&events[index].at<now){
      const e=events[index++];if(!finite(e.at)||!e.mint)throw new Error('Invalid context event');
      const m=members.get(e.mint)??{readyAt:-Infinity,dumpAt:-Infinity,observedAt:-Infinity,weak:false};
      if(e.ready)m.readyAt=e.at;if(e.dump)m.dumpAt=e.at;
      m.weak=m.observedAt===e.at?m.weak||e.weak:!!e.weak;m.observedAt=e.at;members.set(e.mint,m);
    }
    const cutoff=now-900000;let n=0,dumps=0,weak=0;
    for(const[mint,m]of members){
      if(m.observedAt<cutoff){members.delete(mint);continue;}
      if(mint===excludeMint||m.readyAt<cutoff)continue;
      n++;if(m.dumpAt>=cutoff)dumps++;if(m.weak)weak++;
    }
    return {at:now,n,dumps,weak,dumpRate:n?dumps/n:null,weakRate:n?weak/n:null,
      ready:n>=20,windowMs:900000,excludeMint};
  }};
}
export function attachBreadthV14(cases,events){
  const cursor=createBreadthCursorV14(events),out=new Map();
  for(const[id,c]of [...cases].sort((a,b)=>a[1].signal.at-b[1].signal.at)){
    out.set(id,{...c,signal:{...c.signal,breadth:cursor.snapshot(c.signal.at,c.signal.mint)}});
  }return out;
}
export function routeBreadthV14(context,config){
  if(!BREADTH_CONFIGS.some(c=>c.id===config.id&&c.dumpCap===config.dumpCap&&c.healthyAction===config.healthyAction))
    throw new Error('Invalid frozen breadth router');
  if(!context?.ready||!finite(context.dumpRate)||!finite(context.weakRate))return {mode:'UNKNOWN',waitMs:1500};
  if(context.dumpRate>=config.dumpCap)return {mode:'RED',waitMs:null};
  if(context.dumpRate>=config.dumpCap/2||context.weakRate>=.5)return {mode:'AMBER',waitMs:1500};
  return {mode:'HEALTHY',waitMs:config.healthyAction==='FAST'?0:750};
}
export function evaluateBreadthV14(signal,prepared,config,options){
  const route=routeBreadthV14(signal.breadth,config);
  if(route.waitMs===null)return {...options,status:'SKIP',stakeUsd:0,pnl:0,ret:null,at:signal.at,reason:'BREADTH_RED',breadth:signal.breadth,route};
  const peakConfig={id:route.waitMs?`PEAK_FULL_${route.waitMs}`:'PEAK_DIRECT',waitMs:route.waitMs,check:'FULL'};
  return {...evaluatePeakV10(signal,prepared,peakConfig,options),breadth:signal.breadth,route};
}
