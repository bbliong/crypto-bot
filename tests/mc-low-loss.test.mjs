import test from 'node:test';
import assert from 'node:assert/strict';
import { baseline, prepareSession, exitReplay } from '../scripts/search-mc-low-loss.mjs';

test('exit P/L starts at buy-decision price, not initial observation price', () => {
  const s = {mint:'x',startedAt:0,endedAt:40000,entryMarketCapUsd:50000,top1Safe:true};
  const ticks = [{observedAt:1000,priceUsd:100},{observedAt:24000,priceUsd:119},{observedAt:30000,priceUsd:120},{observedAt:35000,priceUsd:116}];
  const r = prepareSession(s,ticks,[{observedAt:100,status:200,top1Percent:10}],true);
  const exit = exitReplay(r,baseline);
  assert.equal(exit.reason,'HARD_STOP');
  assert.ok(Math.abs(exit.ret - (116/120-1)*100) < 1e-10);
});
test('end holder distribution cannot admit a token unsafe at buy time', () => {
  const s = {mint:'x',startedAt:0,endedAt:40000,entryMarketCapUsd:50000,top1Safe:true};
  const ticks = [{observedAt:1000,priceUsd:100},{observedAt:30000,priceUsd:110}];
  const holders = [{observedAt:100,status:200,top1Percent:80},{observedAt:39000,status:200,top1Percent:10}];
  assert.equal(prepareSession(s,ticks,holders,true).top,false);
  assert.equal(prepareSession(s,ticks,holders,false).top,true);
});
test('missing/stale decision data does not look ahead and capture end is not sell', () => {
  const s = {mint:'x',startedAt:0,endedAt:40000,entryMarketCapUsd:50000,top1Safe:true};
  assert.equal(prepareSession(s,[{observedAt:31000,priceUsd:100}],[],true),null);
  assert.equal(prepareSession(s,[{observedAt:1000,priceUsd:100}],[],true),null);
  assert.equal(exitReplay({after:[{at:35000,r:1,r5:0}],buyAt:30000},baseline).reason,'CAPTURE_END_MARK_ONLY');
});
test('variable observation uses that boundary and cannot borrow a later holder', () => {
  const s = {mint:'x',startedAt:0,endedAt:40000,entryMarketCapUsd:50000,top1Safe:true};
  const ticks = [{observedAt:1000,priceUsd:100},{observedAt:10000,priceUsd:105},{observedAt:30000,priceUsd:110}];
  const holders = [{observedAt:5000,status:200,top1Percent:80},{observedAt:25000,status:200,top1Percent:10}];
  const early = prepareSession(s,ticks,holders,true,10);
  assert.equal(early.buyAt,10000); assert.equal(early.buyPrice,105); assert.equal(early.top,false);
  assert.equal(prepareSession(s,ticks,holders,true,30).top,true);
});
test('time limit uses the next observed price, not an invented threshold fill', () => {
  const row = {buyAt:30000,after:[{at:35000,r:1,r5:1},{at:45000,r:-.2,r5:-1}]};
  const result = exitReplay(row,{...baseline,maxHoldSeconds:10});
  assert.equal(result.reason,'TIME_LIMIT_FIRST_OBSERVED_TICK');
  assert.equal(result.at,45000); assert.equal(result.ret,-.2);
});
test('a gap through the hard stop records the actual larger loss', () => {
  const result = exitReplay({buyAt:30000,after:[{at:31000,r:-9,r5:-9}]},{...baseline,hardStop:.5});
  assert.equal(result.reason,'HARD_STOP'); assert.equal(result.ret,-9);
});
test('dev-filtered holders cannot replace an unfiltered Top-1 snapshot', () => {
  const s = {mint:'x',startedAt:0,endedAt:40000,entryMarketCapUsd:50000,top1Safe:true};
  const ticks = [{observedAt:1000,priceUsd:100},{observedAt:10000,priceUsd:105}];
  const holders = [
    {observedAt:8000,status:200,top1Percent:78,queryKeys:['limit','orderby']},
    {observedAt:9000,status:200,top1Percent:.01,queryKeys:['limit','tag','orderby']},
  ];
  assert.equal(prepareSession(s,ticks,holders,true,10,'recorded').top,true);
  const strict = prepareSession(s,ticks,holders,true,10,'unfiltered');
  assert.equal(strict.top,false); assert.equal(strict.top1AtDecision,78);
  assert.equal(prepareSession(s,ticks,holders.slice(1),true,10,'unfiltered').top,false);
});
