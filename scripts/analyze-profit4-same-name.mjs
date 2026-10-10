// Offline same-symbol study. No worker writes, no future labels in entry features.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
const dir=process.argv[2]||'reports/profit4-patterns-2026-10-10';
const read=name=>JSON.parse(fs.readFileSync(path.join(dir,name)));
const source=read('initial-run-analysis.json');
const study=read('runner-study.json');
const cache=JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(dir,'runner-cache.json.gz'))));
const byMint=new Map(cache.tokens.map(t=>[t.mint,t]));
const decision=new Map(study.decisions.filter(d=>d.seconds===30).map(d=>[d.mint,d]));
const normalized=s=>s.trim().toLowerCase();
const median=a=>{a=a.filter(Number.isFinite).sort((a,b)=>a-b);return a.length?(a[Math.floor(a.length/2)]+a[Math.floor((a.length-1)/2)])/2:null;};
const rows=source.rows.map(r=>{
  const token=byMint.get(r.mint),meta=token.meta.filter(m=>m.at<=r.anchorAt);
  const creator=meta.findLast(m=>m.creator_address)?.creator_address??null;
  const creation=meta.findLast(m=>m.creation_timestamp)?.creation_timestamp??null;
  const outcome=r.price600_30m;
  const label=r.price3xx&&['TARGET','DUMP_FIRST'].includes(outcome.status)?outcome.status:null;
  let peakBeforeFirstDump=r.anchorPrice,firstDumpAfterEntryAt=null;
  for(const b of token.series){
    if(b.at<=r.anchorAt)continue;
    peakBeforeFirstDump=Math.max(peakBeforeFirstDump,b.p);
    if(b.p<=peakBeforeFirstDump*.4){firstDumpAfterEntryAt=b.at;break;}
  }
  return {mint:r.mint,symbol:r.symbol,name:normalized(r.symbol),firstAt:r.firstAt,anchorAt:r.anchorAt,
    entryPrice:r.anchorPrice,eligible:r.price3xx,label,observedStatus:outcome.status,
    resolvedAt:label?r.anchorAt+outcome.seconds*1000:null,seconds:outcome.seconds,
    maxBeforeResolution:outcome.maxBeforeResolution,wholeRecordMaxPrice:r.wholeRecordMaxPrice,
    peakBeforeFirstDump,firstDumpAfterEntryAt,
    creator,transferSender:token.creator,creation,features:r.early,
    execution:decision.get(r.mint)?.execution1??null};
}).sort((a,b)=>a.firstAt-b.firstAt);
const grouped=Object.groupBy(rows,r=>r.name);
for(const group of Object.values(grouped))for(let i=0;i<group.length;i++){
  const r=group[i],previous=group[i-1];
  const history=group.slice(0,i).filter(p=>p.label&&p.resolvedAt<r.anchorAt);
  r.priorMint=previous?.mint??null;
  r.priorStatus=!previous?'NO_PRIOR_NAME':!previous.eligible?'PRIOR_INELIGIBLE':!previous.label||previous.resolvedAt>=r.anchorAt?'PRIOR_UNRESOLVED':previous.label;
  r.priorKnownAt=['TARGET','DUMP_FIRST'].includes(r.priorStatus)?previous.resolvedAt:null;
  r.gapSincePreviousMinutes=previous?(r.firstAt-previous.firstAt)/60000:null;
  r.sameCreatorAsPrevious=previous&&r.creator&&previous.creator?r.creator===previous.creator:null;
  r.knownPriorTargets=history.filter(p=>p.label==='TARGET').length;
  r.knownPriorDumps=history.filter(p=>p.label==='DUMP_FIRST').length;
  r.latestResolvedPrior=history.at(-1)?.label??null;
  r.trailingKnownDumps=0;
  for(let j=i-1;j>=0;j--){const p=group[j];if(p.label!=='DUMP_FIRST'||p.resolvedAt>=r.anchorAt)break;r.trailingKnownDumps++;}
}
function summarize(rs){
  const valid=rs.filter(r=>r.label),hits=valid.filter(r=>r.label==='TARGET').length;
  const closed=rs.map(r=>r.execution).filter(e=>e?.status==='CLOSED');
  const n=valid.length,p=n?hits/n:0,z=1.96,den=1+z*z/n;
  const center=n?(p+z*z/(2*n))/den:null;
  const margin=n?z*Math.sqrt(p*(1-p)/n+z*z/(4*n*n))/den:null;
  return {n:rs.length,resolved:n,targets:hits,dumps:valid.length-hits,unknown:rs.length-valid.length,
    targetRatePct:n?100*p:null,wilson95Pct:n?[100*(center-margin),100*(center+margin)]:null,
    executionClosed:closed.length,executionUnresolved:rs.length-closed.length,
    positiveNet:closed.filter(e=>e.net>0).length,meanNetPct:closed.length?closed.reduce((s,e)=>s+e.net,0)/closed.length:null};
}
const eligible=rows.filter(r=>r.eligible);
const rules=[['all',()=>true],['no earlier observed same name',r=>r.priorStatus==='NO_PRIOR_NAME'],
  ['immediate prior dump known',r=>r.priorStatus==='DUMP_FIRST'],['immediate prior target known',r=>r.priorStatus==='TARGET'],
  ['prior ineligible or unresolved',r=>['PRIOR_INELIGIBLE','PRIOR_UNRESOLVED'].includes(r.priorStatus)],
  ['any prior known dump',r=>r.knownPriorDumps>0],['at least 2 consecutive prior known dumps',r=>r.trailingKnownDumps>=2],
  ['latest resolved eligible prior dump',r=>r.latestResolvedPrior==='DUMP_FIRST']];
const groups=Object.entries(grouped).filter(([,rs])=>rs.length>1).map(([name,rs])=>({name,
  all:rs.length,eligible:rs.filter(r=>r.eligible).length,
  targets:rs.filter(r=>r.label==='TARGET').length,dumps:rs.filter(r=>r.label==='DUMP_FIRST').length,
  mixed:rs.some(r=>r.label==='TARGET')&&rs.some(r=>r.label==='DUMP_FIRST'),
  creatorCount:new Set(rs.map(r=>r.creator).filter(Boolean)).size,
  sequence:rs.map(r=>r.label==='TARGET'?'T':r.label==='DUMP_FIRST'?'D':r.eligible?'?':'X').join(' → '),
  mints:rs.map(r=>r.mint)}));
const paired=[];
for(const r of eligible.filter(r=>r.priorStatus==='DUMP_FIRST')){
  const prior=rows.find(p=>p.mint===r.priorMint);
  paired.push({mint:r.mint,symbol:r.symbol,label:r.label,sameCreator:r.sameCreatorAsPrevious,
    ratDelta:Number.isFinite(r.features.ratPct)&&Number.isFinite(prior.features.ratPct)?r.features.ratPct-prior.features.ratPct:null,
    holdersDelta:Number.isFinite(r.features.holderCount)&&Number.isFinite(prior.features.holderCount)?r.features.holderCount-prior.features.holderCount:null});
}
const result={cutoff:source.cutoff,method:'Exact trimmed lowercase symbol, distinct mint, chronological first observation (not global launch order). D = eligible 3xx entry dumps 60% from running peak before 6xx within 30min; T = reaches 6xx first. X = not eligible, not a loss. Entry ~30sec. Prior label must resolve strictly before current entry. Whole-record peak is retrospective and may include bounce.',
  counts:{all:rows.length,uniqueNames:Object.keys(grouped).length,repeatedNames:groups.length,repeatedNameTokens:groups.reduce((s,g)=>s+g.all,0),mixedEligibleGroups:groups.filter(g=>g.mixed).length},
  rules:rules.map(([name,p])=>({name,all:summarize(eligible.filter(p)),early:summarize(eligible.filter(r=>r.firstAt<study.splitAt&&p(r))),late:summarize(eligible.filter(r=>r.firstAt>=study.splitAt&&p(r)))})),
  priorDumpFeatureDeltas:['TARGET','DUMP_FIRST'].map(label=>({label,n:paired.filter(r=>r.label===label).length,
    medianRatDelta:median(paired.filter(r=>r.label===label).map(r=>r.ratDelta)),medianHolderDelta:median(paired.filter(r=>r.label===label).map(r=>r.holdersDelta))})),
  splitAt:study.splitAt,groups,rows};
for(const r of rows)if(r.priorKnownAt!==null&&!(r.priorKnownAt<r.anchorAt))throw new Error('Future-label leakage');
if(rows.length!==new Set(rows.map(r=>r.mint)).size)throw new Error('Duplicate mint');
fs.writeFileSync(path.join(dir,'same-name-analysis.json'),JSON.stringify(result,null,2));
const columns=['symbol','mint','firstAt','anchorAt','entryPrice','eligible','label','resolvedAt','wholeRecordMaxPrice','creator','priorMint','priorStatus','priorKnownAt','sameCreatorAsPrevious','trailingKnownDumps'];
fs.writeFileSync(path.join(dir,'same-name-tokens.csv'),[columns.join(','),...rows.map(r=>columns.map(k=>JSON.stringify(r[k]??'')).join(','))].join('\n')+'\n');
console.log(JSON.stringify({counts:result.counts,rules:result.rules,groups:groups.map(({mints,...g})=>g),featureDeltas:result.priorDumpFeatureDeltas},null,2));
