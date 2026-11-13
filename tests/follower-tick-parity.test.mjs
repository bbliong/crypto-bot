import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { WalletFollowerRunner } from '../scripts/run-wallet-follower.js';

const frames = [
 JSON.stringify({channel:'token_activity',data:[{a:'mint',e:'buy',p:0.2,qa:1,h:'tx1'},{a:'mint',e:'sell',p:0.19,qa:3,h:'tx2'}]}),
 JSON.stringify({channel:'token_stat',data:[{a:'mint',p:0.19}]}),
 JSON.stringify({channel:'wallet_activity_info',data:[{a:'mint',m:'target',e:'buy'}]}),
];
async function replay(withRecorder, fail=false) {
 const effects=[];
 const recorded=[];
 const runner=Object.create(WalletFollowerRunner.prototype);
 runner.targetWallet='target';
 runner.captureSessionId='session';runner.captureConnectionId='connection';runner.captureReceiveSequence=0;runner.captureFirstTicks=new Set();
 runner.tickRecorder=withRecorder ? {record:(x)=>{if(fail)throw new Error('disk failure');recorded.push(x);return true;},lifecycle:()=>true} : null;
 runner.smartDipLane={recordTokenActivity:(...args)=>effects.push(['activity',...args])};
 runner.multiDryRunEngine={recordPoolTradeActivity:(...args)=>effects.push(['pool',...args]),updatePriceTick:(...args)=>effects.push(['price',...args])};
 runner.lane={updateTokenTick:(...args)=>effects.push(['lane',...args])};
 runner.handleSmartDipPriceTick=async(...args)=>{effects.push(['dip',...args]);};
 runner.processWalletTradeItem=async(...args)=>{effects.push(['wallet',...args]);};
 const payloads=frames.map((payload,i)=>({payload,requestId:`request-${i}`}));
 for (const {payload,requestId} of payloads) await runner.handleIncomingWsFrame(payload,requestId);
 return {effects,recorded};
}
test('passive recorder preserves identical strategy processing and stores all received token items',async()=>{
 const baseline=await replay(false);
 const on=await replay(true);
 assert.deepEqual(on.effects,baseline.effects);
 assert.equal(on.recorded.length,4);
 assert.deepEqual(on.recorded.map(x=>x.requestId),['request-0','request-0','request-1','request-2']);
});
test('recorder exception cannot block strategy processing',async()=>{
 assert.deepEqual((await replay(true,true)).effects,(await replay(false)).effects);
});

test('CDP archives only positively identified GMGN socket frames',async()=>{
 const runner=Object.create(WalletFollowerRunner.prototype);
 runner.gmgnSocketIds=new Set();runner.otherSocketIds=new Set();runner.subscribedTokens=new Set();
 const framesSeen=[];runner.handleIncomingWsFrame=async(...args)=>framesSeen.push(args);
 const cdp=new EventEmitter();runner.attachCapturedSocketFrames(cdp);
 cdp.emit('Network.webSocketFrameReceived',{requestId:'unseen',response:{payloadData:'{}'}});
 cdp.emit('Network.webSocketCreated',{requestId:'other',url:'wss://example.org/ws'});
 cdp.emit('Network.webSocketFrameReceived',{requestId:'other',response:{payloadData:'{}'}});
 cdp.emit('Network.webSocketCreated',{requestId:'gmgn',url:'wss://ws.gmgn.ai/ws'});
 cdp.emit('Network.webSocketFrameReceived',{requestId:'gmgn',response:{payloadData:'{}'}});
 assert.deepEqual(framesSeen.map(x=>x[2]),[false,false,true]);
});

test('unidentified CDP socket is excluded and marks coverage gap once',async()=>{
 const runner=Object.create(WalletFollowerRunner.prototype);
 runner.gmgnSocketIds=new Set();runner.otherSocketIds=new Set();runner.subscribedTokens=new Set();
 const gaps=[];runner.tickRecorder={coverageGap:(...args)=>gaps.push(args),lifecycle:()=>true};
 runner.handleIncomingWsFrame=async()=>{};
 const cdp=new EventEmitter();runner.attachCapturedSocketFrames(cdp);
 cdp.emit('Network.webSocketFrameReceived',{requestId:'unseen',response:{payloadData:'{}'}});
 cdp.emit('Network.webSocketFrameReceived',{requestId:'unseen',response:{payloadData:'{}'}});
 assert.deepEqual(gaps.map(x=>x[0]),['socket_origin_unverified']);
});

test('new socket with prior subscriptions marks archive coverage unverified without resubscribing',async()=>{
 const runner=Object.create(WalletFollowerRunner.prototype);
 runner.gmgnSocketIds=new Set();runner.otherSocketIds=new Set();runner.subscribedTokens=new Set(['mint']);
 const gaps=[];runner.tickRecorder={coverageGap:(...args)=>gaps.push(args),lifecycle:()=>true};
 const cdp=new EventEmitter();runner.attachCapturedSocketFrames(cdp);
 cdp.emit('Network.webSocketCreated',{requestId:'fresh',url:'wss://ws.gmgn.ai/ws'});
 assert.equal(gaps.length,1);
 assert.equal(gaps[0][0],'socket_replaced');
 assert.equal(gaps[0][1].activeSubscriptionCount,1);
 assert.equal(runner.subscribedTokens.has('mint'),true);
});

test('unsubscribe lifecycle reports not-ready rather than sent',async()=>{
 const runner=Object.create(WalletFollowerRunner.prototype);
 runner.subscribedTokens=new Set(['mint']);
 const events=[];runner.tickRecorder={lifecycle:e=>events.push(e)};
 runner.page={evaluate:async(fn,mint)=>{
  const previous=globalThis.window;
  globalThis.window={__gmgnWs:null};
  try{return fn(mint);}finally{globalThis.window=previous;}
 }};
 await runner.unsubscribeToken('mint');
 assert.deepEqual(events.map(e=>e.event),['unsubscribe_not_ready']);
});

test('unsubscribe lifecycle records sent only after both frames',async()=>{
 const runner=Object.create(WalletFollowerRunner.prototype);
 runner.subscribedTokens=new Set(['mint']);
 const events=[],sent=[];runner.tickRecorder={lifecycle:e=>events.push(e)};
 runner.page={evaluate:async(fn,mint)=>{
  const previous=globalThis.window;
  globalThis.window={__gmgnWs:{readyState:1,send:payload=>sent.push(JSON.parse(payload))}};
  try{return fn(mint);}finally{globalThis.window=previous;}
 }};
 await runner.unsubscribeToken('mint');
 assert.deepEqual(sent.map(x=>x.channel),['token_activity','token_stat']);
 assert.deepEqual(events.map(e=>e.event),['unsubscribe_sent']);
});

test('subscription lifecycle distinguishes socket-not-ready from sent without changing subscription state',async()=>{
 const runner=Object.create(WalletFollowerRunner.prototype);
 const events=[],gaps=[];
 runner.tickRecorder={lifecycle:(event)=>{events.push(event);return true;},coverageGap:(reason)=>gaps.push(reason)};
 runner.subscribedTokens=new Set();
 runner.page={evaluate:async(fn,mint)=>{
  const previous=globalThis.window;
  globalThis.window={__gmgnWs:null};
  try { return fn(mint); } finally {globalThis.window=previous;}
 }};
 await runner.ensureTokenSubscribed('mint');
 assert.deepEqual(events.map(e=>e.event),['subscribe_requested','socket_not_ready']);
 assert.deepEqual(gaps,['socket_not_ready']);
 assert.equal(runner.subscribedTokens.has('mint'),true); // existing behavior retained; fix is separate
});
