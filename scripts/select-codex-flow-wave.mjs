// Select on earlier data only; evaluate the frozen choice on later dates once.
import {readFileSync,writeFileSync} from 'node:fs';
import {FLOW_WAVE_ENTRIES,FLOW_WAVE_EXITS} from '../src/codex-flow-wave-v2.ts';
const configured=process.argv.includes('--configured');
const input=JSON.parse(readFileSync(configured?'reports/codex-v2-configured-history.json':'reports/codex-v2-all-history.json'));
const split1=Date.parse('2026-09-30T17:00:00Z'),split2=Date.parse('2026-10-02T17:00:00Z');
const round=x=>Number.isFinite(x)?Math.round(x*1e4)/1e4:null;
const day=t=>new Date(t+25200000).toISOString().slice(0,10);
const firstSeen=new Map();
// Purge repeated mints using the full detail universe, not only eventual successful trades.
for(const src of input.inventory){
  const path=`reports/codex-v2-runs/${src.source.replace(/[^a-zA-Z0-9_-]/g,'_')}.json`;
  const data=JSON.parse(readFileSync(path));
  for(const s of data.sessions)firstSeen.set(s.mint,Math.min(firstSeen.get(s.mint)??Infinity,s.start));
}
const guardFamily=[{id:'none',field:null,op:null,value:null}];
const cuts={mc:[10000,15000,30000,50000],return5:[2,5,8,12],flow5:[.7,.8,.9],top1:[3,5],dev:[.5,1],buyers:[5,8],buyUsd:[500,1000],age:[60,120,300]};
for(const[field,values]of Object.entries(cuts))for(const value of values)for(const op of ['min','max'])guardFamily.push({id:`${field}_${op}_${value}`,field,op,value});
function admits(r,g){const x=g.field?r.features[g.field]:null;return !g.field||(Number.isFinite(x)&&(g.op==='min'?x>=g.value:x<=g.value));}
function cases(entry,exit,guard,stake,delay,start=-Infinity,end=Infinity,feeStress=false){
  const seen=new Map(),out=[];
  for(const r of input.records){
    if(r.entryProfile!==entry||r.at<start||r.at>=end-180000||!admits(r,guard))continue;
    if(start!==-Infinity&&(firstSeen.get(r.mint)??r.at)<start)continue;
    if(r.at-(seen.get(r.mint)??-Infinity)<86400000)continue;
    seen.set(r.mint,r.at);
    const o=(feeStress?(r.feeStress??[]):r.outcomes).find(o=>o.exitProfile===exit&&o.stakeUsd===stake&&o.delayMs===delay);
    if(!o)continue;
    // An outcome extending beyond a time partition cannot be imported into training.
    const outcome=o.at!=null&&o.at>=end?{...o,status:'PARTITION_UNKNOWN',pnl:null,ret:null}:o;
    const conservative=outcome.pnl??-(stake+.000205*r.solUsd+(outcome.failedSell??0)*.000105*r.solUsd);
    out.push({id:r.id,mint:r.mint,symbol:r.symbol,source:r.source,day:day(r.at),signalAt:r.at,features:r.features,
      solAssumed:r.solAssumed,solUsd:r.solUsd,...outcome,conservativePnl:conservative});
  }
  return out;
}
function stats(rows){
  const closed=rows.filter(r=>r.status==='CLOSED'),wins=closed.filter(r=>r.ret>0),losses=closed.filter(r=>r.ret<0);
  const known=rows.reduce((n,r)=>n+(r.pnl??0),0),conservative=rows.reduce((n,r)=>n+r.conservativePnl,0);
  const pos=rows.reduce((n,r)=>n+Math.max(0,r.conservativePnl),0),neg=rows.reduce((n,r)=>n-Math.min(0,r.conservativePnl),0);
  const daily={};for(const r of rows)daily[r.day]=(daily[r.day]??0)+r.conservativePnl;
  return {signals:rows.length,closed:closed.length,wins:wins.length,losses:losses.length,
    buyFailed:rows.filter(r=>r.status==='BUY_FAILED').length,unknown:rows.filter(r=>r.status.includes('UNKNOWN')).length,
    knownPnl:round(known),conservativePnl:round(conservative),winRate:closed.length?round(wins.length/closed.length*100):null,
    conservativeMeanPct:rows.length?round(conservative/(rows.length*rows[0].stakeUsd)*100):null,
    closedMeanPct:closed.length?round(closed.reduce((n,r)=>n+r.ret,0)/closed.length):null,
    profitFactor:neg>0?round(pos/neg):null,days:Object.keys(daily).length,positiveDays:Object.values(daily).filter(v=>v>0).length,
    worst:closed.length?round(Math.min(...closed.map(r=>r.ret))):null,daily:Object.fromEntries(Object.entries(daily).map(([k,v])=>[k,round(v)])),
    assumedSol:rows.filter(r=>r.solAssumed).length};
}
function lowerBound(rows){
  if(!rows.length)return -Infinity;
  const groups=new Map();for(const r of rows){const key=Math.floor(r.signalAt/21600000);if(!groups.has(key))groups.set(key,[]);groups.get(key).push(r);}
  const bs=[...groups.values()].map(xs=>({pnl:xs.reduce((n,r)=>n+r.conservativePnl,0),n:xs.length}));
  let seed=932341;const rand=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/4294967296;};
  const estimates=[];
  for(let i=0;i<400;i++){let pnl=0,n=0;for(let j=0;j<bs.length;j++){const b=bs[Math.floor(rand()*bs.length)];pnl+=b.pnl;n+=b.n;}estimates.push(pnl/n/rows[0].stakeUsd*100);}
  estimates.sort((a,b)=>a-b);return estimates[10];
}
function portfolio(rows){
  let busy=-Infinity,blocked=false,total=0,lossStreak=0,pause=-Infinity,currentDay=null,daily=0;
  const selected=[],skipped={pending:0,unresolved:0,lossLimit:0,cooldown:0};
  for(const r of rows){
    if(blocked){skipped.unresolved++;continue;}
    if(r.signalAt<busy){skipped.pending++;continue;}
    if(r.day!==currentDay){currentDay=r.day;daily=0;lossStreak=0;}
    if(daily<=-2*r.stakeUsd){skipped.lossLimit++;continue;}
    if(r.signalAt<pause){skipped.cooldown++;continue;}
    selected.push(r);busy=r.at??Infinity;
    if(r.pnl===null){blocked=true;continue;}
    total+=r.pnl;daily+=r.pnl;
    if(r.status==='CLOSED')lossStreak=r.pnl<0?lossStreak+1:0;
    if(lossStreak>=3){pause=busy+900000;lossStreak=0;}
  }
  return {summary:stats(selected),blocked,skipped,firstUnresolved:selected.find(r=>r.pnl===null)?.id??null};
}
const results={},tables={};
for(const stake of [.5,10]){
  const candidates=[];
  for(const e of FLOW_WAVE_ENTRIES)for(const x of FLOW_WAVE_EXITS)for(const g of guardFamily){
    const rows=cases(e.id,x.id,g,stake,1000,-Infinity,split1),s=stats(rows);
    if(s.closed<30||s.days<3)continue;
    candidates.push({id:`${e.id}/${x.id}/${g.id}`,entry:e,exit:x,guard:g,stats:s,lower95:round(lowerBound(rows))});
  }
  candidates.sort((a,b)=>(b.lower95??-Infinity)-(a.lower95??-Infinity)||b.stats.conservativeMeanPct-a.stats.conservativeMeanPct);
  const eligible=candidates.filter(c=>c.lower95>0&&c.stats.conservativePnl>0&&c.stats.profitFactor>=1.3&&c.stats.unknown/c.stats.signals<=.05);
  const selected=eligible[0]??candidates[0];
  if(!selected){results[stake]={status:'INSUFFICIENT_TRAINING_SAMPLES'};continue;}
  const trainingPassed=eligible.length>0;
  const evaluation={};
  const evaluations=[['train',-Infinity,split1,1000],['validation',split1,split2,1000],['test',split2,Date.parse(input.cutoff),1000],
    ['validationDelay2s',split1,split2,2000],['testDelay2s',split2,Date.parse(input.cutoff),2000],['all',-Infinity,Infinity,1000],['allDelay2s',-Infinity,Infinity,2000]];
  if(configured)evaluations.push(['validationFeeStress',split1,split2,1000,true],['testFeeStress',split2,Date.parse(input.cutoff),1000,true],['allFeeStress',-Infinity,Infinity,1000,true]);
  for(const[key,start,end,delay,feeStress]of evaluations){
    const rows=cases(selected.entry.id,selected.exit.id,selected.guard,stake,delay,start,end,feeStress);
    evaluation[key]={summary:stats(rows),portfolio:portfolio(rows),rows};
  }
  const required=['validation','test','validationDelay2s','testDelay2s',...(configured?['validationFeeStress','testFeeStress']:[])];
  const passed=trainingPassed&&evaluation.validation.summary.closed>=20&&evaluation.test.summary.closed>=10&&
    required.every(k=>evaluation[k].summary.conservativePnl>0&&evaluation[k].summary.unknown===0);
  results[stake]={status:passed?'PROMISING_RETROSPECTIVE_MODEL_ONLY':'NOT_VALIDATED',trainingPassed,selected,evaluation};
  tables[stake]=candidates.slice(0,30);
}
const report={generatedAt:new Date().toISOString(),cutoff:input.cutoff,dataFingerprint:input.fingerprint,counts:input.counts,
  family:{entries:FLOW_WAVE_ENTRIES.length,exits:FLOW_WAVE_EXITS.length,guards:guardFamily.length,total:FLOW_WAVE_ENTRIES.length*FLOW_WAVE_EXITS.length*guardFamily.length,
    guardRule:'At most ONE extra guard; 30 closed and 3 days minimum before training ranking. No retuning after viewing later partitions.'},
  splits:{train:'through 2026-09-30 WIB',validation:'2026-10-01 and 2026-10-02 WIB',test:'2026-10-03 00:00–12:00 WIB'},
  methodology:['Event-study outcomes are NOT a deployable portfolio return; separate one-position portfolio stops at the first unresolved order.',
    'Unknown exposure is conservatively charged as loss of stake plus known/assumed fee in bounds, never described as a realised trade.',
    'One first qualified setup per detail/profile; one attempt per mint per rolling 24h. A rejected first broad setup is not retried at a later price.',
    'Strict on-chain/quote execution gates are not available historically. Every PnL is a socket-based model, NOT actual swaps.',
    'Training search has multiple-comparison risk. Later dates and 2s stress must pass; retrospective historical checking is not prospective validation.',
    'Primary stake remains $0.50. $10 is hypothetical sensitivity, not a settings change. Fees exclude unknown venue fees/rent/market impact.',
    'The unique ZIP capture was read without extracting a second 1.8GB copy. Tick-only studies lacking full holder/dev/order-flow evidence are inventoried, not silently treated as safe.'],
  liveAllowed:false,results,trainingLeaders:tables};
writeFileSync(configured?'reports/codex-v2-configured-selection.json':'reports/codex-v2-selection.json',JSON.stringify(report,null,2));
const small={...report,results:Object.fromEntries(Object.entries(results).map(([k,v])=>[k,{...v,evaluation:v.evaluation?
  Object.fromEntries(Object.entries(v.evaluation).map(([k,x])=>[k,{summary:x.summary,portfolio:x.portfolio}])):undefined}]))};
writeFileSync(configured?'reports/codex-v2-configured-selection-summary.json':'reports/codex-v2-selection-summary.json',JSON.stringify(small,null,2));
console.log(JSON.stringify({counts:input.counts,family:report.family,results:Object.fromEntries(Object.entries(results).map(([k,v])=>[k,{status:v.status,selected:v.selected?.id,
  trainingPassed:v.trainingPassed,evaluation:v.evaluation?Object.fromEntries(Object.entries(v.evaluation).map(([k,x])=>[k,x.summary])):null}]))}));
