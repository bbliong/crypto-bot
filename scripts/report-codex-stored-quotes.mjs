import {readFileSync,writeFileSync,existsSync} from 'node:fs';
import assert from 'node:assert/strict';
import {studyHash} from './codex-cached-opportunity-study.mjs';
import {inspectStoredQuote,summarizeStoredQuotes,NETWORK_SOL_PER_LEG} from './codex-stored-quote-diagnostic.mjs';
const input='reports/codex-all-history-audit.json',out='reports/codex-stored-quote-diagnostic.json';
assert.ok(!existsSync(out),'Preserve earlier diagnostic');
const original=JSON.parse(readFileSync(input)),groups=new Map(),rows=[];
for(const r of original.records){
  if(!(Number.isFinite(r.stake)&&r.stake>0&&Number.isFinite(r.at)))continue;
  const row={id:r.id,mint:r.mint,lane:r.lane,stake:r.stake,at:r.at,symbol:r.symbol,q:inspectStoredQuote(r)};
  rows.push(row);const k=`${r.lane}@${r.stake}`;if(!groups.has(k))groups.set(k,[]);groups.get(k).push(row);
}
const report={generatedAt:new Date().toISOString(),cutoff:original.cutoff,
  hashes:Object.fromEntries([input,'scripts/codex-stored-quote-diagnostic.mjs','scripts/report-codex-stored-quotes.mjs'].map(p=>[p,studyHash(p)])),
  networkSolPerLeg:NETWORK_SOL_PER_LEG,groups:Object.fromEntries([...groups].map(([k,v])=>[k,summarizeStoredQuotes(v)])),rows,
  status:'DESCRIPTIVE_ONLY_NO_LIVE',
  caveats:['All existing records retained; no rescaling a $0.5 quote to a $5 trade.',
    'Quoted outputs already include route fees; no additional platform fee subtracted. Network cost is assumed, not wallet receipts.',
    'Ordering-warning pairs separated, not silently removed. Missing/invalid pairs remain in entry denominator.',
    'Stake-only downside proxy is not a complete cost bound: missing quote may omit additional network/retry/rent costs.',
    'Double network and extra1% output haircut are sensitivities, not a delayed-execution replay.',
    'Without-top3 is hindsight concentration diagnosis, never a trading rule.',
    'Different historical token/time/lane exposure; cannot infer superiority over AGY or live profitability.']};
writeFileSync(out,JSON.stringify(report),{flag:'wx'});
console.log(JSON.stringify({cutoff:report.cutoff,records:rows.length,stake5:Object.fromEntries(Object.entries(report.groups).filter(([k])=>k.endsWith('@5')))}));
