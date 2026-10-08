import test from 'node:test';
import assert from 'node:assert/strict';
import {FOLLOWTHROUGH_CONFIGS,createFollowthroughV21,assessFollowthroughV21,evaluateFollowthroughV21} from '../scripts/codex-followthrough-v21.mjs';
import {replayAdaptiveTrade} from '../scripts/codex-adaptive-engine.mjs';
const state=()=>createFollowthroughV21(FOLLOWTHROUGH_CONFIGS[0],1000,-3,100,1000);
const f=at=>({at,priceAt:at,tickId:String(at),tickCount:0});
test('proof is measured from cost-adjusted initial net and must arrive before deadline',()=>{
  const s=state();assessFollowthroughV21(s,f(2000),-1.9,[]);assert.equal(s.proved,true);
  assert.equal(assessFollowthroughV21(s,f(3250),-2,[]),null);
  const late=state();assert.equal(assessFollowthroughV21(late,f(3250),1,[]),'NO_FOLLOWTHROUGH');assert.equal(late.proved,false);
});
test('early adverse threshold is relative and proof never overrides hard net risk',()=>{
  const s=state();assert.equal(assessFollowthroughV21(s,f(1250),-5,[]),'EARLY_ADVERSE_MOVE');
  s.proved=true;assert.equal(assessFollowthroughV21(s,f(1500),-7,[]),'HARD_NET_RISK');
});
test('stale mark cannot pass proof; deadline still requests exit',()=>{
  const s=state();assert.equal(assessFollowthroughV21(s,{...f(3000),priceAt:1000},10,[]),'NO_FOLLOWTHROUGH');assert.equal(s.proved,false);
});
test('purchase remains identical and missing post-deadline fill remains unknown',()=>{
  const signal={at:0,price:100,solUsd:120,lane:'AGY_NATIVE'};
  const ticks=[{id:'a',observedAt:1000,occurredAt:1000,priceUsd:100,side:'buy',wallet:'a',usd:100}];
  const frames=[{...f(1000),price:100,tickId:'a',tickCount:1},{...f(3000),price:100,priceAt:1000,tickId:'a',tickCount:1}];
  const p={ticks,frames,end:5000},options={delayMs:1000,feeSide:.01};
  const r=evaluateFollowthroughV21(signal,p,FOLLOWTHROUGH_CONFIGS[0],options),b=replayAdaptiveTrade(signal,p,options);
  for(const k of ['buyAt','buyPrice','buyQuantity','initialNet'])assert.equal(r[k],b[k]);
  assert.equal(r.reason,'NO_FOLLOWTHROUGH');assert.equal(r.status,'SELL_UNKNOWN');assert.equal(r.pnl,null);
});
