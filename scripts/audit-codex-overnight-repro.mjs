// Re-read growing sources at the same cutoff. Do not overwrite the first replay.
import {readFileSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
import {isDeepStrictEqual} from 'node:util';
import {historySources,loadHistorySource} from './codex-history-source.mjs';
import {prepareAdaptiveSession,replayAdaptiveTrade} from './codex-adaptive-engine.mjs';
import {SAME_ENTRY_POLICIES,createSameEntryExit,assessSameEntryExit,chooseExitMode} from '../src/codex-same-entry-exits.ts';
import {asOf} from './guarded-wave-replay-core.mjs';
const input=JSON.parse(readFileSync('reports/codex-same-entry-overnight-replay.json'));
for(const[path,expected]of Object.entries(input.hashes))
  assert.equal(createHash('sha256').update(readFileSync(path)).digest('hex'),expected,`Changed code: ${path}`);
const changes=input.sourceInventory.filter(s=>s.changedDuringRead).map(s=>({...s,
  changes:Object.keys(s.before).filter(k=>JSON.stringify(s.before[k])!==JSON.stringify(s.after[k]))}));
const targets=changes.filter(s=>s.changes.some(k=>!(k.endsWith('-wal')&&s.before[k]===null&&s.after[k]?.size===0)));
const sources=historySources(),audits=[];
for(const entry of targets){
  const source=sources.find(s=>s.id===entry.source);assert.ok(source);
  const mints=new Set(input.coverage.filter(s=>input.universe.find(u=>u.id===s.id)?.source===source.id).map(s=>s.mint));
  const data=await loadHistorySource(source,{cutoff:input.cutoff});
  const sol=Object.values(data.tokens).flatMap(d=>d.sol).sort((a,b)=>a.at-b.at);
  const actual=[];
  for(const s of data.sessions.filter(s=>s.start>=input.start&&s.start<input.cutoff)){
    const p=prepareAdaptiveSession(data,s,sol);
    for(const signal of p.signals.filter(r=>r.lane==='AGY_NATIVE')){
      const outcomes=[];
      for(const options of [{delayMs:1000,feeSide:.01},{delayMs:2000,feeSide:.01},{delayMs:1000,feeSide:.02}]){
        outcomes.push({policy:'AGY_NATIVE',...replayAdaptiveTrade(signal,p,options)},
          {policy:'AGY_REFERENCE',...replayAdaptiveTrade({...signal,lane:'AGY_REFERENCE'},p,options)});
        for(const policy of SAME_ENTRY_POLICIES){
          const exitController={create:(at,net,f)=>createSameEntryExit(policy,at,net,f),assess:assessSameEntryExit};
          outcomes.push({policy:`CODEX_${policy}`,...replayAdaptiveTrade(signal,p,{...options,exitController})});
        }
      }
      actual.push({...signal,entryRegime:chooseExitMode(asOf(p.frames,signal.at,'at')),outcomes});
    }
  }
  const expected=input.records.filter(r=>r.source===source.id),sort=rs=>[...rs].sort((a,b)=>a.id.localeCompare(b.id));
  // Match the saved JSON representation: an inactive floor is -Infinity in memory,
  // serialized as null. No rounding or numeric tolerance is applied to finite values.
  assert.ok(isDeepStrictEqual(JSON.parse(JSON.stringify(sort(actual))),sort(expected)),
    `Serialized replay changed at the frozen cutoff: ${source.id}`);
  const expectedSessions=input.coverage.filter(s=>mints.has(s.mint)&&input.universe.find(u=>u.id===s.id)?.source===source.id);
  assert.deepEqual(data.sessions.filter(s=>s.start>=input.start&&s.start<input.cutoff).map(s=>s.id).sort(),expectedSessions.map(s=>s.id).sort());
  audits.push({source:source.id,sessions:expectedSessions.length,signals:actual.length,outcomes:actual.reduce((n,r)=>n+r.outcomes.length,0),exactMatch:true});
}
const report={generatedAt:new Date().toISOString(),fingerprint:input.fingerprint,cutoff:input.cutoff,
  emptyWalOnly:changes.filter(s=>!targets.includes(s)).map(s=>s.source),audits,
  note:'Read-only SQLite queries can create empty WAL sidecars; those do not establish changed observations. Active sources were replayed again; exact signal and outcome equality checked, not byte-for-byte raw snapshot equality.'};
writeFileSync('reports/codex-same-entry-overnight-repro-audit.json',JSON.stringify(report,null,2));
console.log(JSON.stringify(report));
