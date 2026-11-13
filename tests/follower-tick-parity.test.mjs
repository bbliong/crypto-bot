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
test('scenario decision hook preserves generic routing with capture off/on',async()=>{
 const signal={mint:'mint',symbol:'T'};
 const run=(enabled)=>{
  const runner=Object.create(WalletFollowerRunner.prototype),events=[],probes=[];
  runner.tickRecorder=enabled?{decision:e=>events.push(e)}:null;
  runner.multiDryRunEngine={};runner.enqueueGmgnApiProbe=x=>probes.push(x);
  runner.installScenarioActionHandler();
  runner.multiDryRunEngine.onTradeAction('BUY','SCENARIO_4',signal,{reason:'ENTRY',stakeUsd:5,priceUsd:0.1});
  return {events,probes};
 };
 const off=run(false),on=run(true);
 assert.equal(off.events.length,0);
 assert.equal(on.events.length,1);
 assert.equal(on.events[0].kind,'scenario_action');
 assert.equal(on.events[0].originFrame,null);
 assert.equal(on.events[0].mint,'mint');
 assert.equal(on.probes.length,off.probes.length);
 assert.equal(on.probes[0].actionId,on.events[0].actionId);
});

 test('decision writer failure does not suppress generic probe',()=>{
 const runner=Object.create(WalletFollowerRunner.prototype),probes=[];
 runner.tickRecorder={decision:()=>{throw new Error('disk failure')}};
 runner.multiDryRunEngine={};runner.enqueueGmgnApiProbe=x=>probes.push(x);
 runner.installScenarioActionHandler();
 runner.multiDryRunEngine.onTradeAction('SELL','SCENARIO_4',{mint:'mint'},{reason:'EXIT',priceUsd:1});
 assert.equal(probes.length,1);
});

test('AP rejected paper promise is preserved and marked failed without real probe',async()=>{
 const runner=Object.create(WalletFollowerRunner.prototype),events=[],probes=[];
 runner.tickRecorder={decision:e=>events.push(e)};runner.dataDir=process.env.TMPDIR || '/tmp';
 runner.multiDryRunEngine={};runner.isScenarioAllowedForRealOrder=()=>false;
 runner.executeApPaperAction=async()=>{throw new Error('fixture failure')};
 runner.enqueueGmgnApiProbe=x=>probes.push(x);
 runner.installScenarioActionHandler();
 await assert.rejects(runner.multiDryRunEngine.onTradeAction('BUY','SCENARIO_14_BUNDLER_RUNNER',
  {mint:'mint'},{reason:'AP_ENTRY',quoteTicket:{positionId:'p1'}}));
 assert.deepEqual(events.map(e=>e.kind),['scenario_action','paper_simulation']);
 assert.equal(events[1].ok,false);
 assert.equal(probes.length,0);
});

test('AP audit hook records real quote fields and preserves original audit callback',()=>{
 const runner=Object.create(WalletFollowerRunner.prototype),events=[],audits=[];
 runner.tickRecorder={decision:e=>events.push(e)};
 runner.apPaperDependencies={buy:async()=>{},sell:async()=>{},sleep:async()=>{},audit:e=>audits.push(e)};
 const event={type:'AP_PAPER_QUOTE',probe:2,quote:{inAmount:'100',outAmount:'200',inDecimals:9,outDecimals:6},ticket:{positionId:'p1'}};
 runner.apDependencies('a1','SCENARIO_14_BUNDLER_RUNNER',{mint:'mint'},'BUY','ENTRY').audit(event);
 assert.equal(audits.length,1);
 assert.equal(events.length,1);
 assert.equal(events[0].kind,'amm_quote_result');
 assert.equal(events[0].actionId,'a1');
 assert.equal(events[0].outAmountBaseUnits,'200');
});

test('quote wrapper records exactly the helper calls, including retry and failure',async()=>{
 const runner=Object.create(WalletFollowerRunner.prototype),events=[],calls=[];
 runner.tickRecorder={decision:e=>events.push(e)};
 const signal={mint:'mint'};
 const quote={ok:true,status:200,quote:{inAmount:'100',outAmount:'200'}};
 for(let i=1;i<=2;i++){
  const result=await runner.captureAmmQuote('a1','SCENARIO_14_BUNDLER_RUNNER',signal,'SELL','EXIT',i,async()=>{calls.push(i);return quote});
  assert.equal(result,quote);
 }
 await assert.rejects(runner.captureAmmQuote('a1','SCENARIO_14_BUNDLER_RUNNER',signal,'SELL','EXIT',3,async()=>{calls.push(3);throw Error('route failed')}),/route failed/);
 assert.deepEqual(calls,[1,2,3]);
 assert.deepEqual(events.map(e=>[e.kind,e.probeIndex]),[['amm_quote_request',1],['amm_quote_result',1],['amm_quote_request',2],['amm_quote_result',2],['amm_quote_request',3],['amm_quote_result',3]]);
 assert.equal(events[5].ok,false);
});

test('pending rent callback marks capture incomplete before recorder closes',async()=>{
 const runner=Object.create(WalletFollowerRunner.prototype),calls=[];
 runner.tickRecorder={coverageGap:label=>calls.push(label),close:async()=>calls.push('closed')};
 runner.pendingRentCallbacks=1;
 runner.captureLifecycle=()=>{};
 await runner.stop();
 assert.deepEqual(calls,['pending_rent_result_on_shutdown','closed']);
});

test('queued probe retains originating actionId without adding calls',async()=>{
 const runner=Object.create(WalletFollowerRunner.prototype),called=[];
 runner.dataDir=process.env.TMPDIR || '/tmp';runner.probeQueue=[];runner.isProcessingProbeQueue=false;
 runner.isScenarioAllowedForRealOrder=()=>false;
 runner.executeGmgnApiProbe=async(...args)=>called.push(args);
 runner.enqueueGmgnApiProbe({side:'BUY',scenarioId:'SCENARIO_4',signal:{mint:'mint'},stakeUsd:5,priceUsd:0.1,reason:'ENTRY',actionId:'a1'});
 await new Promise(resolve=>setImmediate(resolve));
 assert.equal(called.length,1);
 assert.equal(called[0].at(-1),'a1');
});

test('AP quote-ticket branch records paper outcome without adding route probes',async()=>{
 const runner=Object.create(WalletFollowerRunner.prototype),events=[],probes=[];
 runner.tickRecorder={decision:e=>events.push(e)};
 runner.dataDir=process.env.TMPDIR || '/tmp';runner.multiDryRunEngine={};
 runner.isScenarioAllowedForRealOrder=()=>false;
 runner.executeApPaperAction=async()=>{};
 runner.enqueueGmgnApiProbe=x=>probes.push(x);
 runner.installScenarioActionHandler();
 await runner.multiDryRunEngine.onTradeAction('BUY','SCENARIO_14_BUNDLER_RUNNER',
  {mint:'mint',symbol:'T'},{reason:'AP_ENTRY',quoteTicket:{positionId:'p1'},stakeUsd:5});
 assert.deepEqual(events.map(e=>e.kind),['scenario_action','paper_simulation']);
 assert.equal(events[0].actionId,events[1].actionId);
 assert.equal(events[0].positionId,'p1');
 assert.equal(events[1].ok,undefined); // real recorder serializes absent status as null
 assert.equal(probes.length,0);
});

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
