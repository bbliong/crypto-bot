// Reuse the exact frozen entry signals. Only modeled execution tolerance is changed.
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
import {historySources,loadHistorySource} from './codex-history-source.mjs';
import {prepareFlowWaveSession,replayFlowWave} from './codex-flow-wave-engine.mjs';
import {FLOW_WAVE_EXITS} from '../src/codex-flow-wave-v2.ts';
const input=JSON.parse(readFileSync('reports/codex-v2-all-history.json'));
const groups=new Map();for(const r of input.records){if(!groups.has(r.source))groups.set(r.source,[]);groups.get(r.source).push(r);}
const sources=historySources().filter(s=>groups.has(s.id)),records=[];
mkdirSync('reports/codex-v2-configured-runs',{recursive:true});
let progress=0,parity=0;
for(const source of sources){
  const signals=groups.get(source.id),onlyMints=new Set(signals.map(s=>s.mint)),data=await loadHistorySource(source,{onlyMints});
  const bySession=new Map();for(const r of signals){if(!bySession.has(r.sessionId))bySession.set(r.sessionId,[]);bySession.get(r.sessionId).push(r);}
  const result=[];
  for(const s of data.sessions){
    const ss=bySession.get(s.id);if(!ss)continue;
    const prepared=prepareFlowWaveSession(data,s,[]);
    for(const old of ss){
      const outcomes=[],feeStress=[];
      for(const rule of FLOW_WAVE_EXITS)for(const stakeUsd of [.5,10])for(const delayMs of [1000,2000]){
        const previous=old.outcomes.find(o=>o.exitProfile===rule.id&&o.stakeUsd===stakeUsd&&o.delayMs===delayMs);
        const baseline=replayFlowWave(old,prepared,rule,{stakeUsd,delayMs});
        assert.equal(baseline.status,previous.status,old.id);
        if(baseline.pnl!==null)assert.ok(Math.abs(baseline.pnl-previous.pnl)<1e-10,old.id);parity++;
        // Native buy slippage concerns minimum tokens: price limit = quotedPrice/(1-slippage).
        const options={stakeUsd,delayMs,buyPriceCap:1/(1-.09)-1,sellOutputCap:.14};
        outcomes.push(replayFlowWave(old,prepared,rule,options));
        feeStress.push(replayFlowWave(old,prepared,rule,{...options,feeSide:.02}));
      }
      result.push({...old,outcomes,feeStress});
    }
  }
  records.push(...result);progress++;
  writeFileSync(`reports/codex-v2-configured-runs/${source.id.replace(/[^a-zA-Z0-9_-]/g,'_')}.json`,JSON.stringify({source:source.id,records:result}));
  console.log(JSON.stringify({progress:`${progress}/${sources.length}`,source:source.id,signals:result.length,parityChecks:parity}));
}
records.sort((a,b)=>a.at-b.at);
assert.equal(records.length,input.records.length);
const sourceHashes=Object.fromEntries(['scripts/codex-history-source.mjs','scripts/codex-flow-wave-engine.mjs','src/codex-flow-wave-v2.ts']
  .map(p=>[p,createHash('sha256').update(readFileSync(p)).digest('hex')]));
writeFileSync('reports/codex-v2-configured-history.json',JSON.stringify({...input,sourceHashes,execution:{buySlippagePercent:9,sellSlippagePercent:14,
  entrySignalsFrozen:true,liveSettingsChanged:false,parityChecks:parity,feeStress:'Additional 1% per side, explicitly rerun exits'},records}));
console.log(JSON.stringify({output:'reports/codex-v2-configured-history.json',signals:records.length,parityChecks:parity}));
