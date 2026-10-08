// Pure reporting helpers; no future outcomes are used to assign a cohort or train a selector.
export const EXIT_COMPARATORS=['AGY_NATIVE','AGY_REFERENCE','CODEX_DEFENSIVE','CODEX_TREND','CODEX_PULLBACK','CODEX_CONTEXT'];
export const round=x=>Number.isFinite(x)?Math.round(x*1e4)/1e4:null;
export const wibDay=at=>new Date(at+25200000).toISOString().slice(0,10);
export function commonCohort(records,universe,start,end){
  const first=new Map();for(const s of universe)first.set(s.mint,Math.min(first.get(s.mint)??Infinity,s.start));
  const seen=new Map(),selected=[];
  for(const r of [...records].sort((a,b)=>a.at-b.at)){
    if(r.at-(seen.get(r.mint)??-Infinity)<86400000)continue;
    seen.set(r.mint,r.at);
    if(r.at<start||r.at>=end-180000||(start!==-Infinity&&(first.get(r.mint)??r.at)<start))continue;
    selected.push(r);
  }return selected;
}
export function outcomeRows(cohort,policy,delayMs,feeSide,end=Infinity){
  return cohort.map(r=>{
    let o=r.outcomes.find(o=>o.policy===policy&&o.delayMs===delayMs&&o.feeSide===feeSide);
    if(!o)throw new Error(`Missing paired outcome: ${r.id} ${policy}`);
    if(o.at!==null&&o.at>=end)o={...o,status:'PARTITION_UNKNOWN',at:null,pnl:null,ret:null};
    return {id:r.id,mint:r.mint,symbol:r.symbol,entryRegime:r.entryRegime,features:r.features,signalAt:r.at,
      captureEnd:Math.min(r.captureEnd,end),solUsd:r.solUsd,solAssumed:r.solAssumed,day:wibDay(r.at),...o,
      bound:o.pnl??-(5+.000205*r.solUsd+(o.failedSell??0)*.000105*r.solUsd)};
  });
}
export function exitStats(rows){
  const closed=rows.filter(r=>r.status==='CLOSED'),wins=closed.filter(r=>r.ret>0),losses=closed.filter(r=>r.ret<0);
  const known=rows.reduce((s,r)=>s+(r.pnl??0),0),bound=rows.reduce((s,r)=>s+r.bound,0);
  const gain=rows.reduce((s,r)=>s+Math.max(0,r.bound),0),pain=-rows.reduce((s,r)=>s+Math.min(0,r.bound),0);
  let nav=0,peak=0,dd=0;
  for(const r of [...rows].sort((a,b)=>(a.at??a.captureEnd)-(b.at??b.captureEnd))){nav+=r.bound;peak=Math.max(peak,nav);dd=Math.max(dd,peak-nav);}
  return {signals:rows.length,closed:closed.length,wins:wins.length,losses:losses.length,
    buyFailed:rows.filter(r=>r.status==='BUY_FAILED').length,unknown:rows.filter(r=>r.pnl===null).length,
    days:new Set(rows.map(r=>r.day)).size,mints:new Set(rows.map(r=>r.mint)).size,
    knownPnl:round(known),conservativePnl:round(bound),profitFactor:pain?round(gain/pain):null,
    winRate:closed.length?round(wins.length/closed.length*100):null,
    meanClosedPct:closed.length?round(closed.reduce((s,r)=>s+r.ret,0)/closed.length):null,
    worstPct:closed.length?round(Math.min(...closed.map(r=>r.ret))):null,tailLoss10:closed.filter(r=>r.ret<=-10).length,
    eventBoundDrawdown:round(dd),assumedSol:rows.filter(r=>r.solAssumed).length};
}
export function pairedExitDifference(rows,baseline){
  const byId=new Map(baseline.map(r=>[r.id,r]));
  if(rows.length!==baseline.length)throw new Error('Different cohort sizes');
  const pairs=rows.map(r=>{const b=byId.get(r.id);if(!b)throw new Error(`Unmatched entry ${r.id}`);
    for(const k of ['buyAt','buyPrice','buyQuantity','initialNet'])if(r[k]!==b[k])throw new Error(`Different buy: ${r.id} ${k}`);
    return {candidate:r,baseline:b,diff:r.bound-b.bound};});
  const known=pairs.filter(p=>p.candidate.pnl!==null&&p.baseline.pnl!==null);
  const blocks=new Map();for(const p of pairs){const key=Math.floor(p.candidate.signalAt/21600000);
    if(!blocks.has(key))blocks.set(key,[]);blocks.get(key).push(p.diff);}
  const bs=[...blocks.values()],draws=[];let seed=381745;
  const random=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/4294967296;};
  if(bs.length)for(let i=0;i<800;i++){let sum=0,n=0;for(let j=0;j<bs.length;j++){
    const b=bs[Math.floor(random()*bs.length)];sum+=b.reduce((s,x)=>s+x,0);n+=b.length;}draws.push(sum/n);}
  draws.sort((a,b)=>a-b);
  return {pairs:pairs.length,bothKnown:known.length,candidateUnknown:pairs.filter(p=>p.candidate.pnl===null).length,
    baselineUnknown:pairs.filter(p=>p.baseline.pnl===null).length,knownOnlyDifference:round(known.reduce((s,p)=>s+p.candidate.pnl-p.baseline.pnl,0)),
    conservativeDifference:round(pairs.reduce((s,p)=>s+p.diff,0)),betterKnown:known.filter(p=>p.candidate.pnl>p.baseline.pnl+1e-9).length,
    worseKnown:known.filter(p=>p.candidate.pnl<p.baseline.pnl-1e-9).length,blocks:bs.length,
    bootstrapMeanDifferenceLow:round(draws[Math.floor(draws.length*.025)]),bootstrapMeanDifferenceHigh:round(draws[Math.floor(draws.length*.975)])};
}
