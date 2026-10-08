import {readFileSync,writeFileSync} from 'node:fs';
import {assessCodexHourEvidence,wibHourBlock} from '../src/codex-adaptive-wave-v3.ts';
import {simulateOnePosition} from './codex-portfolio.mjs';
const input=JSON.parse(readFileSync('reports/codex-adaptive-v3-replay.json'));
const firstSeen=new Map();for(const s of input.universe)firstSeen.set(s.mint,Math.min(firstSeen.get(s.mint)??Infinity,s.start));
const day=at=>new Date(at+25200000).toISOString().slice(0,10);
const unique=(lane)=>{
  const seen=new Map();return input.records.filter(r=>r.lane===lane).filter(r=>{
    if(r.at-(seen.get(r.mint)??-Infinity)<86400000)return false;seen.set(r.mint,r.at);return true;
  });
};
const eventRows=unique('CODEX_EVENT');
const shadow=eventRows.map(r=>{const o=r.outcomes[0];return {id:r.id,mint:r.mint,mode:r.mode,signalAt:r.at,
  availableAt:o.at??r.captureEnd,unknown:o.pnl===null,returnPct:o.ret??(o.pnl===null?-100:o.pnl/5*100)};});
const round=x=>Number.isFinite(x)?Math.round(x*1e4)/1e4:null;
function stats(rows){
  const closed=rows.filter(r=>r.status==='CLOSED'),wins=closed.filter(r=>r.ret>0),loss=closed.filter(r=>r.ret<0);
  const known=rows.reduce((s,r)=>s+(r.pnl??0),0),bound=rows.reduce((s,r)=>s+r.bound,0);
  const gain=rows.reduce((s,r)=>s+Math.max(0,r.bound),0),pain=-rows.reduce((s,r)=>s+Math.min(0,r.bound),0);
  let nav=0,peak=0,dd=0;for(const r of [...rows].sort((a,b)=>(a.at??a.captureEnd)-(b.at??b.captureEnd))){nav+=r.bound;peak=Math.max(peak,nav);dd=Math.max(dd,peak-nav);}
  return {signals:rows.length,closed:closed.length,wins:wins.length,losses:loss.length,
    buyFailed:rows.filter(r=>r.status==='BUY_FAILED').length,unknown:rows.filter(r=>r.pnl===null).length,
    knownPnl:round(known),conservativeBoundPnl:round(bound),profitFactor:round(pain?gain/pain:null),
    meanClosedPct:closed.length?round(closed.reduce((s,r)=>s+r.ret,0)/closed.length):null,
    worstPct:closed.length?round(Math.min(...closed.map(r=>r.ret))):null,conservativeEventDrawdownUsd:round(dd),
    tailLoss10:closed.filter(r=>r.ret<=-10).length,assumedSol:rows.filter(r=>r.solAssumed).length};
}
const evaluation={};
for(const[name,start,end]of [['development',-Infinity,input.split],['test',input.split,input.cutoff],['all',-Infinity,input.cutoff]]){
  evaluation[name]={};
  for(const lane of ['AGY_NATIVE','AGY_REFERENCE','CODEX_EVENT','CODEX_GATED'])for(const[scenario,delay,fee]of [['base',1000,.01],['delay2s',2000,.01],['feeStress',1000,.02]]){
    const rows=[],rejections={};
    for(const r of unique(lane==='CODEX_GATED'?'CODEX_EVENT':lane)){
      if(r.at<start||r.at>=end-180000||(start!==-Infinity&&firstSeen.get(r.mint)<start))continue;
      let evidence=null;
      if(lane==='CODEX_GATED'){
        evidence=assessCodexHourEvidence(shadow,r.at,r.mode);
        if(!evidence.allowed){rejections[evidence.reason]=(rejections[evidence.reason]??0)+1;continue;}
      }
      let o=r.outcomes.find(o=>o.delayMs===delay&&o.feeSide===fee);
      if(o.at!==null&&o.at>=end)o={...o,status:'PARTITION_UNKNOWN',at:null,pnl:null,ret:null};
      rows.push({...r,...o,signalAt:r.at,day:day(r.at),bound:o.pnl??-(5+.000205*r.solUsd+(o.failedSell??0)*.000105*r.solUsd),hourEvidence:evidence});
    }
    evaluation[name][`${lane}/${scenario}`]={summary:stats(rows),portfolio:simulateOnePosition(rows,5),rejections,rows};
  }
}
const hourTable=[];
for(const block of [0,4,8,12,16,20])for(const mode of ['IMPULSE','TREND','RECLAIM']){
  const xs=evaluation.development['CODEX_EVENT/base'].rows.filter(r=>wibHourBlock(r.signalAt)===block&&r.mode===mode);
  hourTable.push({blockWib:`${String(block).padStart(2,'0')}:00–${String((block+4)%24).padStart(2,'0')}:00`,mode,
    distinctMints:new Set(xs.map(r=>r.mint)).size,days:new Set(xs.map(r=>r.day)).size,...stats(xs)});
}
const paired={};
const cx=evaluation.test['CODEX_EVENT/base'].rows;
for(const lane of ['AGY_NATIVE','AGY_REFERENCE']){
  const others=new Map(evaluation.test[`${lane}/base`].rows.map(r=>[r.mint,r])),pairs=cx.filter(r=>others.has(r.mint));
  paired[lane]={mints:pairs.length,codexBound:round(pairs.reduce((s,r)=>s+r.bound,0)),
    agyBound:round(pairs.reduce((s,r)=>s+others.get(r.mint).bound,0))};
}
const c=evaluation.test['CODEX_EVENT/base'].summary;
const preliminary=c.closed>=30&&c.unknown===0&&c.conservativeBoundPnl>0&&
  ['base','delay2s','feeStress'].every(s=>evaluation.test[`CODEX_EVENT/${s}`].summary.conservativeBoundPnl>0&&
    evaluation.test[`CODEX_EVENT/${s}`].summary.unknown===0)&&
  ['AGY_NATIVE','AGY_REFERENCE'].every(l=>{
    const b=evaluation.test[`${l}/base`].summary;
    return c.conservativeBoundPnl>b.conservativeBoundPnl&&c.worstPct>=b.worstPct&&
      c.conservativeEventDrawdownUsd<=b.conservativeEventDrawdownUsd&&
      (c.tailLoss10/c.closed)<=(b.tailLoss10/Math.max(1,b.closed))&&paired[l].mints>=20&&paired[l].codexBound>paired[l].agyBound;
  });
const report={generatedAt:new Date().toISOString(),cutoff:new Date(input.cutoff).toISOString(),split:new Date(input.split).toISOString(),
  fingerprint:input.fingerprint,sourceHashes:input.hashes,counts:{sessions:input.universe.length,
    developmentSessions:input.universe.filter(s=>s.start<input.split).length,testSessions:input.universe.filter(s=>s.start>=input.split).length,
    allSignalRecords:input.records.length},
  status:preliminary?'PRELIMINARY_ONLY_REQUIRES_7_DAY_FORWARD_CHECK':'NO_VALIDATED_OUTPERFORMANCE',liveAllowed:false,
  evaluation,hourTable,paired,caveats:[...input.caveats,
    'Clock evidence learns only already-available shadow outcomes, including earlier outcomes during the held-out period. Rules never retuned on test.',
    'Hour confidence is a conservative heuristic, not a calibrated confidence interval. Unknown outcomes are penalized, not treated as zero.',
    'Gated zero-trade results are abstention, not evidence of a profitable strategy.',
    'Event drawdown assumes independent entries; only the separately reported portfolio enforces one position and unresolved lock.',
    'Native AGY, peak/net reference, and Codex all use a shared quality adapter. Different entry frequencies do not imply matched risk exposure.',
    'This short test cannot demonstrate the required 7-day/100-trade positive forward performance.']};
writeFileSync('reports/codex-adaptive-v3-comparison.json',JSON.stringify(report,null,2));
const small={...report,evaluation:Object.fromEntries(Object.entries(evaluation).map(([part,lanes])=>[part,
  Object.fromEntries(Object.entries(lanes).map(([k,v])=>[k,{...v,rows:undefined,portfolio:{...v.portfolio,selectedIds:undefined}}]))]))};
writeFileSync('reports/codex-adaptive-v3-summary.json',JSON.stringify(small,null,2));
console.log(JSON.stringify({counts:report.counts,status:report.status,test:Object.fromEntries(Object.entries(evaluation.test).map(([k,v])=>[k,v.summary]))}));
