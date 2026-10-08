import test from 'node:test';
import assert from 'node:assert/strict';
import {contextModeV22,createContextV22,assessContextV22,safeSignalsV22,evaluateSafeV22} from '../scripts/codex-safe-context-v22.mjs';
const frame=(at=1000)=>({at,price:100,priceAt:at,tickId:String(at),tickCount:1,ready:true,holderFresh:true,devFresh:true,countFresh:true,
  sigma1:1,buy2:.8,buy5:.8,buy20:.8,return2:1,efficiency20:.8,historySec:20,devSell30:0,majorSell:false,collapse1s:0,
  holders:200,top1:1,top5:4,dev:0,mc:10000,tokenAgeSec:100,sellUsd:0,sellers:0});
test('context depends on evidence, not hour; missing evidence and danger veto entry',()=>{
  const a=frame();assert.equal(contextModeV22(a),'RUNNER');
  assert.equal(contextModeV22({...a,at:a.at+12*3600000,priceAt:a.priceAt+12*3600000}),'RUNNER');
  assert.equal(contextModeV22({...a,efficiency20:.2}),'SCALP');
  assert.equal(contextModeV22({...a,holderFresh:false}),'WAIT');
  assert.equal(contextModeV22({...a,majorSell:true}),'DEFEND');
});
test('switch needs persistent mode and fresh distinct ticks; floor never loosens',()=>{
  const s=createContextV22(1000,-3,{...frame(),efficiency20:.2});
  assessContextV22(s,frame(1250),10);assert.equal(s.mode,'SCALP');const floor=s.floor;
  assessContextV22(s,frame(2000),10);assert.equal(s.mode,'SCALP');
  assessContextV22(s,frame(2250),10);assert.equal(s.mode,'RUNNER');assert.ok(s.floor>=floor);assert.equal(s.switches,1);
});
test('hard risk and absolute deadline override runner',()=>{
  const s=createContextV22(1000,-3,frame());
  assert.equal(assessContextV22(s,frame(1250),-7),'HARD_NET_RISK');
  assert.equal(assessContextV22(s,frame(46000),1),'ABSOLUTE_TIME_LIMIT');
});
test('independent safe signal is causal and confirmation waits for another tick',()=>{
  const ticks=Array.from({length:16},(_,i)=>({id:String(i),observedAt:i*500,occurredAt:i*500,priceUsd:100+i*.3,
    side:'buy',usd:100,wallet:String(i%5)}));
  const frames=[6000,6250,6500].map(at=>({...frame(at),price:100+Math.floor(at/500)*.3,
    priceAt:Math.floor(at/500)*500,tickId:String(Math.floor(at/500)),tickCount:Math.floor(at/500)+1,buy5:1,buy20:1,historySec:at/1000}));
  const session={id:'s',mint:'m',start:0},prepared={frames,ticks,end:10000};
  const first=safeSignalsV22(session,prepared,[{at:0,usd:120}]);
  assert.equal(first.find(s=>s.lane==='SAFE_CONTEXT_0').at,6000);
  assert.equal(first.find(s=>s.lane==='SAFE_CONTEXT_500').at,6500);
  assert.deepEqual(safeSignalsV22(session,{...prepared,ticks:[...ticks,{...ticks[0],id:'future',observedAt:20000,occurredAt:20000,priceUsd:1}]},[{at:0,usd:120}]),first);
});
test('matched control uses identical fill; absent sell tick remains unknown',()=>{
  const signal={at:0,price:100,solUsd:120},ticks=[{id:'a',observedAt:1000,occurredAt:1000,priceUsd:100,side:'buy',usd:100,wallet:'a'}];
  const p={ticks,frames:[{...frame(1000),tickId:'a'}, {...frame(47000),priceAt:1000,tickId:'a'}],end:48000},o={delayMs:1000,feeSide:.01};
  const r=evaluateSafeV22(signal,p,'CONTEXT',o),b=evaluateSafeV22(signal,p,'SAFE_NATIVE',o);
  for(const k of ['buyAt','buyPrice','buyQuantity','initialNet'])assert.equal(r[k],b[k]);
  assert.equal(r.status,'SELL_UNKNOWN');assert.equal(r.pnl,null);
});
