import test from 'node:test';
import assert from 'node:assert/strict';
import {inspectStoredQuote,summarizeStoredQuotes} from '../scripts/codex-stored-quote-diagnostic.mjs';
const example=()=>({paired:true,exitAt:3000,buyQuote:{at:1000,inAmount:'100000000',outAmount:'9007199254740993',inDecimals:9,outDecimals:6,inUsd:10},
  sellQuote:{at:3000,inAmount:'9007199254740993',outAmount:'110000000',inDecimals:6,outDecimals:9}});
test('quote fee not charged twice; adds only assumed network and retains warning separately',()=>{
  const r=example(),q=inspectStoredQuote(r);assert.equal(q.status,'ORDERED_QUOTE_PAIR');assert.ok(Math.abs(q.pnl-.959)<1e-10);
  r.exitAt=500;const late=inspectStoredQuote(r);assert.equal(late.status,'QUOTE_ORDERING_WARNING');assert.equal(late.pnl,q.pnl);
});
test('quantities are matched as integers, not rounded floating amounts',()=>{
  const r=example();r.sellQuote.inAmount='9007199254740992';assert.equal(inspectStoredQuote(r).status,'INVALID_PAIR');
});
test('missing pairs stay in denominator and downside proxy, not fabricated wins',()=>{
  const q=inspectStoredQuote(example());const x=summarizeStoredQuotes([{at:0,stake:10,q},{at:1,stake:10,q:{status:'MISSING_PAIR',pnl:null}}]);
  assert.equal(x.entries,2);assert.equal(x.paired,1);assert.equal(x.missingStake,10);assert.ok(Math.abs(x.downsideStakeProxy-(q.pnl-10))<1e-10);
});
