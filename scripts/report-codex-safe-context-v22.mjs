// Descriptive coverage only. Never select hours/modes from these outcomes.
import {readFileSync,writeFileSync,existsSync} from 'node:fs';
import assert from 'node:assert/strict';
import {studyHash} from './codex-cached-opportunity-study.mjs';
import {exitStats} from './codex-same-entry-analysis.mjs';
const input='reports/codex-safe-context-v22-results.json',out='reports/codex-safe-context-v22-coverage.json';
assert.ok(!existsSync(out),'Preserve completed coverage report');
const report=JSON.parse(readFileSync(input)),selected=report.selected.id;
function group(rows,key){
  const bins=new Map();for(const r of rows){const k=key(r);if(!bins.has(k))bins.set(k,[]);bins.get(k).push(r);}
  return Object.fromEntries([...bins].map(([k,rs])=>[k,exitStats(rs)]));
}
const periods=Object.fromEntries(Object.entries(report.results).map(([part,lanes])=>[part,
  Object.fromEntries(['AGY_NATIVE','AGY_REFERENCE','SAFE_NATIVE',selected].map(l=>{
    const rows=lanes[l].base.rows;
    return [l,{byDay:group(rows,r=>r.day),byHour:group(rows,r=>String(new Date(r.signalAt+25200000).getUTCHours()).padStart(2,'0')),
      byMode:group(rows,r=>r.entryMode),byExit:group(rows,r=>r.reason??r.status)}];
  }))]));
const rows=Object.values(report.results).flatMap(ls=>ls[selected].base.rows),hours=new Set(rows.map(r=>new Date(r.signalAt+25200000).getUTCHours()));
const result={generatedAt:new Date().toISOString(),input,inputHash:studyHash(input),selected,periods,
  coverage:{observedHours:[...hours].sort((a,b)=>a-b),unobservedHours:Array.from({length:24},(_,i)=>i).filter(h=>!hours.has(h)),
    modes:[...new Set(rows.map(r=>r.entryMode))],signals:rows.length},
  caveats:['Descriptive historical bins, not an hour-selection strategy. Do not optimize on evaluated outcomes.',
    'Independent event PnL per bin is not portfolio PnL; cumulative blocked portfolio stays in main report.',
    'Presence of signals in an hour is not evidence of reliable profit or full coverage.']};
writeFileSync(out,JSON.stringify(result,null,2),{flag:'wx'});
console.log(JSON.stringify(result.coverage));
