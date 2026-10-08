import test from 'node:test';
import assert from 'node:assert/strict';
import {evaluateForwardResearch} from '../scripts/codex-forward-research-engine.mjs';
import {BREADTH_CONFIGS} from '../scripts/codex-breadth-router-v14.mjs';
import {NORMALIZED_CONFIGS} from '../scripts/codex-normalized-breadth-v16.mjs';
import {VALUE_ACTIONS,VALUE_CONFIGS} from '../scripts/codex-action-value-v15.mjs';
const registry={peak:{selected:{waitMs:1500,check:'FULL'}},normalized:{selected:NORMALIZED_CONFIGS[0]},
  value:{selected:VALUE_CONFIGS[0],heads:Object.fromEntries(VALUE_ACTIONS.map(a=>[a.id,null]))}};
const seedLabels=Object.fromEntries(VALUE_ACTIONS.map(a=>[a.id,[]]));
function example(at,mint){
  const ticks=[[1000,100],[2000,103],[4000,90],[5000,92]].map(([dt,price],i)=>({
    id:`${mint}:${i}`,observedAt:at+dt,occurredAt:at+dt,priceUsd:price,usd:100,side:'buy',wallet:`w${i}`}));
  const frames=ticks.map((t,i)=>({at:t.observedAt,price:t.priceUsd,priceAt:t.observedAt,tickId:t.id,tickCount:i+1}));
  return {signal:{id:mint,sessionId:mint,mint,at,price:100,solUsd:120,captureEnd:at+10000,lane:'AGY_NATIVE',mode:'AGY',features:{}},
    prepared:{ticks,frames,end:at+10000}};
}
function evaluate(cases,cutoff){
  return evaluateForwardResearch({cases,universe:[...cases.values()].map(c=>({id:c.signal.sessionId,mint:c.signal.mint,start:c.signal.at})),
    contextEvents:[],registry,start:0,cutoff,seedLabels});
}
test('fresh harness retains modeled fills and no-history wait separately',()=>{
  const r=evaluate(new Map([['a',example(0,'a')]]),200000);
  assert.equal(r.results.AGY_NATIVE.base.summary.closed,1);
  assert.ok(r.results.AGY_NATIVE.base.summary.knownPnl<0);
  assert.equal(r.results.ACTION_VALUE_ONLINE_V17.base.summary.closed,0);
  assert.equal(r.results.ACTION_VALUE_ONLINE_V17.base.summary.skips,1);
  assert.equal(r.liveAllowed,false);assert.equal(r.promising.length,0);
});
test('adding genuinely future cases preserves prior online model/action hashes',()=>{
  const cases=new Map([['a',example(0,'a')]]),first=evaluate(cases,200000);
  cases.set('b',example(200000,'b'));const next=evaluate(cases,400000);
  assert.deepEqual(first.decisions.a,next.decisions.a);
});
test('unresolved portfolio does not reset at the next snapshot',()=>{
  const first=example(0,'a');first.prepared.ticks=first.prepared.ticks.slice(0,1);first.prepared.frames=[];
  const cases=new Map([['a',first]]);assert.equal(evaluate(cases,200000).results.AGY_NATIVE.base.portfolio.blocked,true);
  cases.set('b',example(200000,'b'));const next=evaluate(cases,400000).results.AGY_NATIVE.base.portfolio;
  assert.equal(next.blocked,true);assert.equal(next.attempts,1);assert.equal(next.skipped.unresolved,1);
});
