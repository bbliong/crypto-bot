import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {loadHistorySource,HISTORY_CUTOFF} from '../scripts/codex-history-source.mjs';
test('explicit later cutoff includes new sessions without changing the original default snapshot',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'codex-adaptive-history-test-'));
  try{
    const events=[{type:'DETAIL_STARTED',mint:'old',startedAt:HISTORY_CUTOFF-1000,worker:1},
      {type:'DETAIL_STARTED',mint:'new',startedAt:HISTORY_CUTOFF+1000,worker:1}];
    writeFileSync(join(dir,'events.jsonl'),events.map(x=>JSON.stringify(x)).join('\n'));
    writeFileSync(join(dir,'trades.jsonl'),events.map(x=>JSON.stringify({mint:x.mint,observedAt:x.startedAt,
      occurredAt:x.startedAt,priceUsd:1,side:'buy',wallet:'w',amountUsd:1})).join('\n'));
    const a=await loadHistorySource({id:'fixture',dir});
    const b=await loadHistorySource({id:'fixture',dir},{cutoff:HISTORY_CUTOFF+3000});
    assert.equal(a.sessions.length,1);assert.equal(b.sessions.length,2);
    assert.equal(a.sessions[0].end,HISTORY_CUTOFF);
    assert.equal(b.tokens.new.ticks.length,1);
  }finally{rmSync(dir,{recursive:true,force:true});}
});
