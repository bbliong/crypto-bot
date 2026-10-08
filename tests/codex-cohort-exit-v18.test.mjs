import test from 'node:test';
import assert from 'node:assert/strict';
import {entryCohortV18,cohortPressureV18,COHORT_CONFIGS,evaluateCohortV18} from '../scripts/codex-cohort-exit-v18.mjs';
import {evaluatePeakV10} from '../scripts/codex-peak-recheck-v10.mjs';
const tick=(id,observedAt,wallet,side,usd)=>({id,observedAt,wallet,side,usd});
test('entry cohort is causal, net of sells, deduplicated, and ignores anonymous trades',()=>{
  const ts=[tick('a',9500,'a','buy',100),tick('a',9500,'a','buy',100),tick('b',9600,'a','sell',30),
    tick('old',5000,'x','buy',500),tick('future',10001,'z','buy',500),tick('anon',9900,null,'buy',500)];
  const c=entryCohortV18(ts,10000);assert.equal(c.total,70);assert.deepEqual([...c.buyers.keys()],['a']);
});
test('cohort recycling ignores other sellers and future ticks and offsets replenishment',()=>{
  const c={buyers:new Map([['a',100],['b',100]]),total:200};
  const ts=[tick('a',11000,'a','sell',80),tick('a',11000,'a','sell',80),tick('b',11000,'b','buy',40),
    tick('c',11000,'other','sell',500),tick('d',13000,'b','sell',1000)];
  assert.deepEqual(cohortPressureV18(c,ts,10000,12000),{outflow:40,sellers:1});
});
test('cohort exit preserves purchase but triggers on support wallets selling',()=>{
  const ticks=[tick('a',9000,'a','buy',100),tick('b',9500,'b','buy',100),tick('fill',11000,'z','buy',10),
    tick('out',12000,'a','sell',100),tick('sellfill',13000,'z','buy',10)]
    .map(t=>({...t,priceUsd:100,occurredAt:t.observedAt}));
  const frames=ticks.map((t,i)=>({at:t.observedAt,priceAt:t.observedAt,price:100,tickId:t.id,tickCount:i+1}));
  const signal={at:10000,price:100,solUsd:120,lane:'AGY_NATIVE'},p={ticks,frames,end:14000},options={delayMs:1000,feeSide:.01};
  const r=evaluateCohortV18(signal,p,COHORT_CONFIGS[0],options);
  const b=evaluatePeakV10(signal,p,{waitMs:0},options);
  for(const key of ['buyAt','buyPrice','buyQuantity','initialNet'])assert.equal(r[key],b[key]);
  assert.equal(r.reason,'ENTRY_BUYER_RECYCLE');assert.equal(r.at,13000);assert.ok(r.pnl<0);
});
test('missing wallet evidence is identical to peak fallback and cannot prevent unknown',()=>{
  const ticks=[{id:'a',observedAt:11000,occurredAt:11000,priceUsd:100,side:'buy',usd:100,wallet:null}];
  const p={ticks,frames:[],end:14000},s={at:10000,price:100,solUsd:120,lane:'AGY_NATIVE'},o={delayMs:1000,feeSide:.01};
  const r=evaluateCohortV18(s,p,COHORT_CONFIGS[0],o),b=evaluatePeakV10(s,p,{waitMs:0},o);
  assert.equal(r.status,'SELL_UNKNOWN');assert.equal(r.status,b.status);assert.equal(r.pnl,null);
});
