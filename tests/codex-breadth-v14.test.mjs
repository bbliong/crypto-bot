import test from 'node:test';
import assert from 'node:assert/strict';
import {createBreadthCursorV14,breadthEventsV14,routeBreadthV14,evaluateBreadthV14,BREADTH_CONFIGS} from '../scripts/codex-breadth-router-v14.mjs';
const e=(at,mint,dump=false)=>({at,mint,ready:true,weak:false,dump});
test('context never reads simultaneous or future events',()=>{
  const cursor=createBreadthCursorV14([e(1,'a'),e(2,'b',true),e(3,'c')]);
  const s=cursor.snapshot(2,'z');assert.equal(s.n,1);assert.equal(s.dumps,0);
  assert.deepEqual(s,createBreadthCursorV14([e(1,'a')]).snapshot(2,'z'));
});
test('target mint and repeated sessions do not inflate breadth denominator',()=>{
  const c=createBreadthCursorV14([e(1,'a'),e(2,'a'),e(2,'self',true)]).snapshot(3,'self');
  assert.equal(c.n,1);assert.equal(c.dumps,0);
});
test('recent dump stays remembered after a subsequent price recovery',()=>{
  const s=createBreadthCursorV14([e(1,'a',true),e(2,'a')]).snapshot(3,'z');assert.equal(s.dumps,1);
});
test('context expires and cannot be rewound into future-tainted state',()=>{
  const cursor=createBreadthCursorV14([e(1,'a')]);assert.equal(cursor.snapshot(900002,'z').n,0);
  assert.throws(()=>cursor.snapshot(10,'z'),/chronological/);
});
test('fewer than 20 other mints is unknown, not a healthy market',()=>{
  assert.deepEqual(routeBreadthV14({ready:false,dumpRate:0,weakRate:0},BREADTH_CONFIGS[0]),{mode:'UNKNOWN',waitMs:1500});
});
test('red stops new orders and skips are not profitable closed trades',()=>{
  const r=evaluateBreadthV14({at:10,breadth:{ready:true,dumpRate:.2,weakRate:0}}, {}, BREADTH_CONFIGS[0],{delayMs:1000,feeSide:.01});
  assert.equal(r.status,'SKIP');assert.equal(r.stakeUsd,0);assert.equal(r.pnl,0);
});
test('router action responds to current earlier-event context only',()=>{
  assert.equal(routeBreadthV14({ready:true,dumpRate:0,weakRate:0},BREADTH_CONFIGS[0]).waitMs,0);
  assert.equal(routeBreadthV14({ready:true,dumpRate:0,weakRate:0},BREADTH_CONFIGS[1]).waitMs,750);
  assert.equal(routeBreadthV14({ready:true,dumpRate:.07,weakRate:0},BREADTH_CONFIGS[0]).waitMs,1500);
});
test('silence and same-tick frames do not create context refreshes',()=>{
  const f=at=>({at,priceAt:0,tickId:'x',ready:true,buy5:.8,return2:1,collapse1s:0});
  assert.equal(breadthEventsV14({mint:'m'},{frames:[f(0),f(250),f(1000),f(5000)]}).length,1);
});
