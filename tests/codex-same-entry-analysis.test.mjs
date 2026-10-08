import test from 'node:test';
import assert from 'node:assert/strict';
import {commonCohort,outcomeRows,exitStats,pairedExitDifference} from '../scripts/codex-same-entry-analysis.mjs';
const row=(id,pnl)=>({id,mint:id,signalAt:1000,day:'2026-10-02',at:2000,captureEnd:3000,
  status:pnl===null?'SELL_UNKNOWN':'CLOSED',pnl,ret:pnl===null?null:pnl/5*100,bound:pnl??-5.1,
  buyAt:1100,buyPrice:1,buyQuantity:4.95,initialNet:-3});
test('cohort uses first-seen mint, chronological attempt limit and partition buffer only',()=>{
  const records=[{id:'old',mint:'old',at:400000},{id:'a',mint:'new',at:410000},{id:'b',mint:'new',at:420000},{id:'c',mint:'late',at:900000}];
  const universe=[{mint:'old',start:0},{mint:'new',start:400000},{mint:'late',start:800000}];
  assert.deepEqual(commonCohort(records,universe,300000,1000000).map(r=>r.id),['a']);
});
test('a sell after partition end is unknown inside that partition',()=>{
  const r={id:'a',mint:'a',at:1000,captureEnd:6000,solUsd:120,outcomes:[{...row('a',1),at:5000,policy:'X',delayMs:1000,feeSide:.01}]};
  const xs=outcomeRows([r],'X',1000,.01,4000);
  assert.equal(xs[0].status,'PARTITION_UNKNOWN');assert.equal(xs[0].pnl,null);assert.ok(xs[0].bound < -5);
});
test('paired analysis rejects different buy prices or quantities',()=>{
  assert.throws(()=>pairedExitDifference([row('a',1)],[{...row('a',.5),buyQuantity:5}]),/Different buy/);
  assert.throws(()=>pairedExitDifference([row('a',1)],[row('b',1)]),/Unmatched/);
});
test('unknown exposure is visible; differences of bounds are separate from known paired improvements',()=>{
  const a=[row('a',1),row('b',null)],b=[row('a',.5),row('b',2)];
  const p=pairedExitDifference(a,b),s=exitStats(a);
  assert.equal(p.bothKnown,1);assert.equal(p.knownOnlyDifference,.5);assert.equal(p.candidateUnknown,1);
  assert.equal(p.conservativeDifference,-6.6);assert.equal(s.knownPnl,1);assert.equal(s.conservativePnl,-4.1);
});
test('paired bootstrap is reproducible without random-number or time dependencies',()=>{
  const a=Array.from({length:8},(_,i)=>({...row(String(i),i/10),signalAt:i*21600000}));
  const b=a.map(r=>({...r,pnl:r.pnl-.1,bound:r.bound-.1}));
  assert.deepEqual(pairedExitDifference(a,b),pairedExitDifference(a,b));
  assert.equal(pairedExitDifference(a,b).bootstrapMeanDifferenceLow,.1);
});
test('overnight cohort purges a previously observed mint even without an earlier buy',()=>{
  const start=86400000,end=start+1000000;
  const records=[{id:'a',mint:'seen',at:start+1000},{id:'b',mint:'fresh',at:start+2000}];
  const universe=[{mint:'seen',start:start-1},{mint:'seen',start:start+500},{mint:'fresh',start}];
  assert.deepEqual(commonCohort(records,universe,start,end).map(r=>r.id),['b']);
});
test('end embargo excludes the exact 180-second boundary and the following entries',()=>{
  const end=1000000,records=[{id:'a',mint:'a',at:end-180001},{id:'b',mint:'b',at:end-180000},
    {id:'c',mint:'c',at:end-1}];
  assert.deepEqual(commonCohort(records,[],0,end).map(r=>r.id),['a']);
});
test('empty periods cannot manufacture a positive paired confidence interval',()=>{
  const stats=exitStats([]),pair=pairedExitDifference([],[]);
  assert.equal(stats.signals,0);assert.equal(stats.winRate,null);
  assert.equal(pair.pairs,0);assert.equal(pair.bootstrapMeanDifferenceLow,null);
});
