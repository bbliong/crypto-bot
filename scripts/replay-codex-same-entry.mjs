// Reuse every frozen AGY buy. Only the exit callback varies. No APIs or live configuration writes.
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
import {historySources,loadHistorySource,readHistoryLines} from './codex-history-source.mjs';
import {prepareAdaptiveSession,replayAdaptiveTrade} from './codex-adaptive-engine.mjs';
import {SAME_ENTRY_POLICIES,createSameEntryExit,assessSameEntryExit,chooseExitMode} from '../src/codex-same-entry-exits.ts';
import {asOf} from './guarded-wave-replay-core.mjs';
const old=JSON.parse(readFileSync('reports/codex-adaptive-v3-replay.json'));
const cutoff=Date.parse('2026-10-03T12:55:00Z'),split=old.cutoff;
const files=['src/codex-same-entry-exits.ts','scripts/codex-adaptive-engine.mjs','scripts/codex-flow-wave-engine.mjs',
  'scripts/codex-history-source.mjs','src/momentum-strategy.ts','src/adaptive-wave.ts','docs/CODEX_SAME_ENTRY_EXIT_PROTOCOL.md'];
const hashes=Object.fromEntries(files.map(p=>[p,createHash('sha256').update(readFileSync(p)).digest('hex')]));
const fingerprint=createHash('sha256').update(JSON.stringify(hashes)+cutoff).digest('hex');
const sources=historySources(),groups=new Map();
for(const r of old.records.filter(r=>r.lane==='AGY_NATIVE')){if(!groups.has(r.source))groups.set(r.source,[]);groups.get(r.source).push(r);}
const records=[],freshUniverse=[],inventory=[];let parity=0,buyParity=0,progress=0;
mkdirSync('reports/codex-same-entry-runs',{recursive:true});
function evaluate(signal,p,previous){
  const outcomes=[];
  for(const options of [{delayMs:1000,feeSide:.01},{delayMs:2000,feeSide:.01},{delayMs:1000,feeSide:.02}]){
    const native=replayAdaptiveTrade({...signal,lane:'AGY_NATIVE'},p,options);
    const reference=replayAdaptiveTrade({...signal,lane:'AGY_REFERENCE'},p,options);
    if(previous)for(const[lane,outcome]of [['AGY_NATIVE',native],['AGY_REFERENCE',reference]]){
      const prev=lane==='AGY_NATIVE'?previous:old.records.find(r=>r.sessionId===signal.sessionId&&r.lane===lane);
      const expected=prev.outcomes.find(o=>o.delayMs===options.delayMs&&o.feeSide===options.feeSide);
      for(const[k,v]of Object.entries(expected)){
        if(typeof v==='number')assert.ok(Math.abs(outcome[k]-v)<1e-9,`${signal.id} ${k}`);
        else assert.deepEqual(outcome[k],v,`${signal.id} ${k}`);
      }
      parity++;
    }
    const all=[{policy:'AGY_NATIVE',...native},{policy:'AGY_REFERENCE',...reference}];
    for(const policy of SAME_ENTRY_POLICIES){
      const exitController={create:(at,net,f)=>createSameEntryExit(policy,at,net,f),assess:assessSameEntryExit};
      all.push({policy:`CODEX_${policy}`,...replayAdaptiveTrade(signal,p,{...options,exitController})});
    }
    // For a scenario, all exits share the same position and sunk purchase costs.
    for(const o of all)for(const k of ['buyAt','buyPrice','buyQuantity','initialNet']){assert.equal(o[k],native[k],`${signal.id} ${o.policy} ${k}`);buyParity++;}
    outcomes.push(...all);
  }
  const entry=asOf(p.frames,signal.at,'at');
  return {...signal,entryRegime:chooseExitMode(entry),fresh:signal.at>=split,outcomes};
}
for(const source of sources.filter(s=>groups.has(s.id))){
  const signals=groups.get(source.id),data=await loadHistorySource(source,{onlyMints:new Set(signals.map(r=>r.mint)),cutoff:split});
  const result=[];
  for(const s of data.sessions){const ss=signals.filter(r=>r.sessionId===s.id);if(!ss.length)continue;
    const p=prepareAdaptiveSession(data,s,[]);
    for(const r of ss)result.push(evaluate(r,p,r));
  }
  records.push(...result);progress++;
  inventory.push({source:source.id,oldSignals:result.length});
  writeFileSync(`reports/codex-same-entry-runs/${source.id.replace(/[^a-zA-Z0-9_-]/g,'_')}.json`,JSON.stringify({fingerprint,records:result}));
  console.log(JSON.stringify({progress:`${progress}/${groups.size}`,signals:result.length,parity,buyParity}));
}
assert.equal(records.length,old.records.filter(r=>r.lane==='AGY_NATIVE').length);
// Only event metadata is scanned to discover new sessions, including continuously running old-named sources.
const freshSources=[];
for(const source of sources){let fresh=false;
  await readHistoryLines(source,'events.jsonl',x=>{if(x.type==='DETAIL_STARTED'&&x.startedAt>=split&&x.startedAt<cutoff)fresh=true;});
  if(fresh)freshSources.push(source);
}
for(const source of freshSources){
  const data=await loadHistorySource(source,{cutoff}),sol=Object.values(data.tokens).flatMap(d=>d.sol).sort((a,b)=>a.at-b.at);
  for(const s of data.sessions.filter(s=>s.start>=split)){
    freshUniverse.push({id:s.id,mint:s.mint,start:s.start,end:s.end});
    const p=prepareAdaptiveSession(data,s,sol);
    for(const r of p.signals.filter(r=>r.lane==='AGY_NATIVE'))records.push(evaluate(r,p,null));
  }
}
records.sort((a,b)=>a.at-b.at);
const report={fingerprint,hashes,priorFingerprint:old.fingerprint,split,cutoff,stakeUsd:5,parityChecks:parity,buyParityChecks:buyParity,
  universe:[...old.universe,...freshUniverse],records,inventory,liveAllowed:false,
  caveats:['All entries frozen from AGY in the common as-of adapter; this is not full live-service replication.',
    'Every outcome is an independent event study unless explicitly labeled one-position portfolio.',
    'Quote receipts/actual chain fees/ATA rent remain incomplete; shared socket fill model, not actual fills.',
    'All data before 2026-10-03T12:00Z is previously inspected. Fresh window is short and cannot establish live profitability.']};
writeFileSync('reports/codex-same-entry-replay.json',JSON.stringify(report));
console.log(JSON.stringify({output:'reports/codex-same-entry-replay.json',oldSignals:records.filter(r=>!r.fresh).length,
  freshSignals:records.filter(r=>r.fresh).length,freshDetails:freshUniverse.length,parity,buyParity}));
