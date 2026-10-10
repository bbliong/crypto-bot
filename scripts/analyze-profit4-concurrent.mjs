// Read-only pair study: distinct mints, separate observation/transfer/creation clocks.
import fs from 'node:fs';
import path from 'node:path';
const dir=process.argv[2]||'reports/profit4-patterns-2026-10-10';
const read=f=>JSON.parse(fs.readFileSync(path.join(dir,f)));
const source=read('same-name-analysis.json'),old=read('analysis.json');
const prior=new Map(old.rows.map(r=>[r.mint,r]));
const pairs=[];
for(let i=0;i<source.rows.length;i++)for(let j=i+1;j<source.rows.length;j++){
  const a=source.rows[i],b=source.rows[j],oa=prior.get(a.mint),ob=prior.get(b.mint);
  const labels=[a.label,b.label];
  pairs.push({names:[a.symbol,b.symbol],mints:[a.mint,b.mint],sameName:a.name===b.name,
    firstAt:[a.firstAt,b.firstAt],observedGapSeconds:(b.firstAt-a.firstAt)/1000,
    transferGapSeconds:Number.isFinite(oa.transferAt)&&Number.isFinite(ob.transferAt)?Math.abs(ob.transferAt-oa.transferAt)/1000:null,
    creationGapSeconds:a.creation&&b.creation?Math.abs(b.creation-a.creation):null,
    captureIntervalsOverlap:oa.lastAt>=b.firstAt,
    earlierTokenDumpedBeforeLaterAppeared:a.firstDumpAfterEntryAt!==null&&a.firstDumpAfterEntryAt<=b.firstAt,
    labels,pairOutcome:labels.every(Boolean)?labels[0]!==labels[1]?'MIXED':labels[0]==='TARGET'?'BOTH_TARGET':'BOTH_DUMP':'NOT_BOTH_RESOLVED_ELIGIBLE'});
}
pairs.sort((a,b)=>a.observedGapSeconds-b.observedGapSeconds);
const count=ps=>({pairs:ps.length,sameName:ps.filter(p=>p.sameName).length,
  mixed:ps.filter(p=>p.pairOutcome==='MIXED').length,bothTarget:ps.filter(p=>p.pairOutcome==='BOTH_TARGET').length,
  bothDump:ps.filter(p=>p.pairOutcome==='BOTH_DUMP').length,other:ps.filter(p=>p.pairOutcome==='NOT_BOTH_RESOLVED_ELIGIBLE').length});
const currentFiles=[];
function walk(d){for(const e of fs.readdirSync(d,{withFileTypes:true})){const p=path.join(d,e.name);if(e.isDirectory())walk(p);else if(e.name==='watch-events.jsonl'||e.name==='profit4-state.json')currentFiles.push({path:p,bytes:fs.statSync(p).size});}}
walk('data/profit4-watch');
const current=new Map(),states=[];
for(const f of currentFiles){
  if(f.path.endsWith('profit4-state.json')){
    const s=JSON.parse(fs.readFileSync(f.path));states.push({path:f.path,observedAt:s.observedAt,positions:s.positions.length,uniqueMints:new Set(s.positions.map(p=>p.mint)).size,lanes:[...new Set(s.positions.map(p=>p.laneLabel))]});continue;
  }
  if(!f.bytes)continue;
  const fd=fs.openSync(f.path,'r'),buf=Buffer.alloc(f.bytes);fs.readSync(fd,buf,0,f.bytes,0);fs.closeSync(fd);
  for(const line of buf.toString().split('\n')){
    let e;try{e=JSON.parse(line);}catch{continue;}
    if(e.type!=='TOKEN_DETAIL_OPENED'||!e.transfer?.mint)continue;
    const t=e.transfer,seen=current.get(t.mint);
    if(!seen||seen.firstAt>e.observedAt)current.set(t.mint,{mint:t.mint,symbol:t.symbol,firstAt:e.observedAt,transferAt:t.timestamp*1000});
  }
}
const groups=Object.groupBy([...current.values()],r=>r.symbol.trim().toLowerCase());
const result={historicalCutoff:source.cutoff,method:'Distinct-mint pairs. Same name means trimmed lowercase symbol. First-observed proximity is not simultaneous creation. Labels inherited from 3xx-to-6xx-before-dump study. Pair counts are dependent, not independent trials or causal evidence. Capture interval overlap does not imply continuous observation or two live pre-dump tokens.',
  windows:[60,180,300,600,1800].map(seconds=>({seconds,...count(pairs.filter(p=>p.observedGapSeconds<=seconds))})),
  nearestSameName:pairs.find(p=>p.sameName),sameNameCaptureOverlaps:pairs.filter(p=>p.sameName&&p.captureIntervalsOverlap),
  pairsWithin5Minutes:pairs.filter(p=>p.observedGapSeconds<=300),
  currentRunCheck:{checkedAt:new Date().toISOString(),inputFiles:currentFiles,states,distinctOpenedMints:current.size,repeatedNames:Object.entries(groups).filter(([,r])=>r.length>1),rows:[...current.values()]}};
fs.writeFileSync(path.join(dir,'concurrent-analysis.json'),JSON.stringify(result,null,2));
console.log(JSON.stringify({windows:result.windows,nearestSameName:result.nearestSameName,overlaps:result.sameNameCaptureOverlaps,current:{states,mints:current.size,repeatedNames:result.currentRunCheck.repeatedNames}},null,2));
