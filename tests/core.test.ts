import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import type { Page } from 'playwright';
import { loadConfig } from '../src/config.js';
import { parseCandidates, decodeFrame, describeFrame, validMint } from '../src/parser.js';
import { evaluate } from '../src/risk.js';
import { Store } from '../src/store.js';
import { CandidateQueue } from '../src/queue.js';
import { assessExit } from '../src/positions.js';
import { attachCapture } from '../src/capture.js';
import { parseTokenActivities } from '../src/activity.js';
import { assessBlindProtection, assessCandleHistory, assessEarlyCandleRising, assessEntryStability, assessSimulation, assessSingleCandleHolderOverride, openSimulation, type SimulationExitReason } from '../src/research-simulation.js';
import type { Candidate, Field, Mapping } from '../src/model.js';

const mint = 'FDW1Et4FS6sYLjByZNNvB8ZzwZ4eh9HG2snB97Jzpump';
const cfg = { ...loadConfig(), phase: 2 as const };
const now = 1789887887000;
const mapping: Mapping = { channel:'test_tokens',recordsPath:'data',chainPath:'c',chainValue:'sol',mintPath:'mint',
  fields:{holders:{path:'holders'},createdAt:{path:'created',unit:'seconds'},mintVerified:{path:'verified'}} };
function candidate(values: Partial<Record<Field, number | boolean>>, time = now): Candidate {
  return {mint,firstSeenAt:time,updatedAt:time,fields:Object.fromEntries(Object.entries(values).map(([k,v])=>[k,{value:v,observedAt:time,source:'test-fixture'}]))};
}
const complete: Partial<Record<Field, number | boolean>> = {
  createdAt:now-60000, holders:102, liquidityUsd:10000, buys:80, sells:10,
  risePercent:50, drawdownPercent:10, mintVerified:true, holdersComplete:true, ownersResolved:true,
  top5Percent:15,top10Percent:20,singlePercent:4,bundlingComplete:true,bundledPercent:5,
  sameSlotWallets:3,sharedFunderWallets:2,walletMapComplete:true,developerLinkedCluster:false,
  largestClusterPercent:8,developerComplete:true,developerPercent:2,developerSoldPercent:0,
  mintAuthorityActive:false,freezeAuthorityActive:false,lpVerified:true,lpWithdrawable:false,
  tokenExtensionsVerified:true,transferHookActive:false,transferFeePercent:0,
};
test('base58 validates actual 32-byte addresses, rejects truncated or malformed data',()=>{
  assert.ok(validMint(mint)); assert.ok(!validMint('58oQ')); assert.ok(!validMint('../bad')); assert.ok(!validMint('z'.repeat(44)));
});
test('user route_info and twitter samples never become token candidates',()=>{
  for (const channel of ['chain_stat','public_broadcast']) {
    const guarded = channel === 'public_broadcast' ? {...mapping, channel, eventPath:'et', eventValue:'signal'} : {...mapping,channel};
    assert.deepEqual(parseCandidates({channel,data:[{c:'sol',t:'route_info',gk:mint,mint,holders:100}]},[guarded],now,'sample'),[]);
  }
  assert.equal(decodeFrame('{"channel":"chain_stat","data":[{"gk":"58oQ'),null);
});
test('explicit mapping checks chain and timestamp units, never coerces false or null to zero',()=>{
  const input = {channel:'test_tokens',data:[{c:'sol',mint,created:(now-30000)/1000,holders:'102',verified:false}]};
  const [c] = parseCandidates(input,[mapping],now,'test');
  assert.equal(c.fields.createdAt?.value,now-30000); assert.equal(c.fields.holders?.value,102); assert.equal(c.fields.mintVerified?.value,false);
  input.data[0].c='eth'; assert.deepEqual(parseCandidates(input,[mapping],now,'test'),[]);
  const [missing] = parseCandidates({channel:'test_tokens',data:[{c:'sol',mint,holders:null,verified:'false'}]},[mapping],now,'test');
  assert.deepEqual(missing.fields,{});
});
test('verified token_stat mapping refreshes one-minute buy and sell counts',()=>{
  const tokenStat = cfg.mappings.find(item => item.channel === 'token_stat');
  assert.ok(tokenStat);
  const [c] = parseCandidates({channel:'token_stat',data:[{n:'sol',a:mint,b1m:47,s1m:9}]},[tokenStat],now,'detail');
  assert.equal(c.fields.buys?.value,47); assert.equal(c.fields.sells?.value,9);
});
test('schema persistence excludes credential values and URL query parameters',()=>{
  const text=JSON.stringify(describeFrame({channel:'chain_stat',device_id:'PRIVATE',authorization:'SECRET',data:[{gk:mint,d:{rs:'PAYLOAD'}}]}));
  for (const secret of ['PRIVATE','SECRET','PAYLOAD',mint]) assert.ok(!text.includes(secret));
});
test('complete evidence passes, missing critical evidence cannot pass',()=>{
  assert.equal(evaluate(candidate(complete),cfg,now).status,'ENTRY_READY');
  for(const key of ['walletMapComplete','lpVerified','mintVerified','createdAt'] as Field[]) {
    const c=candidate(complete); delete c.fields[key];
    assert.equal(evaluate(c,cfg,now).status,'INSUFFICIENT_EVIDENCE',key);
  }
});
test('phase 1 uses only verified WebSocket screening fields',()=>{
  const phase1 = { ...cfg, phase: 1 as const };
  const report = evaluate(candidate({
    createdAt: now - 60_000, holders: 100, liquidityUsd: 10_000, buys: 60, sells: 12, top10Percent: 20,
    priceUsd: 10, price1mUsd: 11, price5mUsd: 12, price1hUsd: 9,
  }), phase1, now);
  assert.equal(report.status, 'ENTRY_READY');
  assert.deepEqual(report.checks.map(check => check.name), ['age','holders','liquidityUsd','buys','sellBuyRatio','top10Percent','drawdownPercent']);
  assert.equal(evaluate(candidate({
    createdAt: now - 60_000, holders: 100, liquidityUsd: 10_000, buys: 60, sells: 12, top10Percent: 20,
    priceUsd: 5, price1mUsd: 20, price5mUsd: 10, price1hUsd: 4,
  }), phase1, now).status, 'REJECT');
});
test('stale evidence, late token, active authority, and warn policy',()=>{
  assert.equal(evaluate(candidate(complete),cfg,now+16000).status,'INSUFFICIENT_EVIDENCE');
  assert.equal(evaluate(candidate({...complete,createdAt:now+1000}),cfg,now).status,'REJECT');
  assert.equal(evaluate(candidate({...complete,createdAt:now-901000}),cfg,now).status,'REJECT');
  assert.equal(evaluate(candidate({...complete,mintAuthorityActive:true}),cfg,now).status,'REJECT');
  assert.equal(evaluate(candidate({...complete,risePercent:300}),cfg,now).status,'WATCH');
  assert.equal(evaluate(candidate({...complete,risePercent:300,drawdownPercent:30}),cfg,now).status,'REJECT');
});
test('SQLite merges mint updates without refreshing older evidence and retains checkpoints',()=>{
  const store=new Store(':memory:');
  try {
    store.merge(candidate({holders:75,liquidityUsd:20000},now));
    const c=store.merge(candidate({holders:102},now+500));
    assert.equal(c.firstSeenAt,now);assert.equal(c.fields.liquidityUsd?.observedAt,now);
    assert.equal(store.merge(candidate({holders:50},now-100)).fields.holders?.value,102);
    assert.equal(store.db.prepare('SELECT count(*) AS n FROM candidates').get()?.n,1);
    assert.equal(store.db.prepare('SELECT count(*) AS n FROM checkpoints').get()?.n,4);
  } finally {store.close();}
});
test('queue deduplicates active and pending jobs, enforces capacity and expiry',()=>{
  const q=new CandidateQueue(1,100);
  assert.equal(q.push('a',0),'queued');assert.equal(q.push('a',1),'duplicate');assert.equal(q.push('b',2),'full');
  assert.equal(q.take(3),'a');assert.equal(q.push('a',4),'duplicate');q.done('a');
  assert.equal(q.push('b',5),'queued');assert.equal(q.take(106),undefined);
});
test('queue takes the newest pending token first',()=>{
  const q=new CandidateQueue(3,100);
  q.push('older',0);q.push('newer',1);
  assert.equal(q.take(2),'newer');
  assert.equal(q.take(3),'older');
});
test('exit target uses real fill and total executable net proceeds',()=>{
  const p={mint,kind:'manual' as const,filledAt:now-1000,quantity:10,fillPriceUsd:10,entryFeesUsd:2};
  assert.equal(assessExit(p,{mint,quantity:10,observedAt:now,netProceedsUsd:153},now).status,'TARGET_REACHED');
  assert.equal(assessExit(p,{mint,quantity:10,observedAt:now,netProceedsUsd:150},now).status,'POSITION_OPEN');
  assert.equal(assessExit(p,{mint,quantity:10,observedAt:now-6000,netProceedsUsd:200},now).status,'INSUFFICIENT_EVIDENCE');
});
test('paper simulation exits at target, trailing loss, hard stop, and persistent sell pressure',()=>{
  const target=openSimulation(mint,now,10); assert.equal(assessSimulation(target,14,{buys:0,sells:0,buyUsd:0,sellUsd:0,uniqueSellers:0}).exitReason,'TARGET_40');
  const trailing=openSimulation(mint,now,10); assessSimulation(trailing,13,{buys:0,sells:0,buyUsd:0,sellUsd:0,uniqueSellers:0}); assert.equal(assessSimulation(trailing,11.5,{buys:0,sells:0,buyUsd:0,sellUsd:0,uniqueSellers:0}).exitReason,'TRAILING_10');
  const stopped=openSimulation(mint,now,10); assert.equal(assessSimulation(stopped,8,{buys:0,sells:0,buyUsd:0,sellUsd:0,uniqueSellers:0}).exitReason,'STOP_LOSS_20');
  const pressure=openSimulation(mint,now,10), window={buys:3,sells:8,buyUsd:1,sellUsd:9,uniqueSellers:3,windowStart:0}; assert.equal(assessSimulation(pressure,9.4,window).exitReason,null); assert.equal(assessSimulation(pressure,9.4,window).exitReason,null); assert.equal(assessSimulation(pressure,9.4,{...window,windowStart:5000}).exitReason,'SELL_PRESSURE');
});
test('simulation exit reason accepts DEV_DUMP_EXIT and TOP_HOLDER_DUMP',()=>{
  const reasons: SimulationExitReason[] = ['DEV_DUMP_EXIT', 'TOP_HOLDER_DUMP', 'MOMENTUM_EXHAUSTION_5S', 'PROFIT_STAGNATION_10S'];
  assert.equal(reasons.includes('DEV_DUMP_EXIT'), true);
  assert.equal(reasons.includes('TOP_HOLDER_DUMP'), true);
});
test('paper simulation can defer a +40% target for holder momentum while preserving hard stop',()=>{
  const position=openSimulation(mint,now,10);
  assert.equal(assessSimulation(position,14,{buys:0,sells:0,buyUsd:0,sellUsd:0,uniqueSellers:0},{deferTargetForHolderMomentum:true}).exitReason,null);
  assert.equal(assessSimulation(position,8,{buys:0,sells:0,buyUsd:0,sellUsd:0,uniqueSellers:0},{deferTargetForHolderMomentum:true}).exitReason,'STOP_LOSS_20');
});
test('paper buy waits while the detail price keeps falling, then permits stable price data',()=>{
  assert.equal(assessEntryStability([{observedAt:0,priceUsd:10},{observedAt:1000,priceUsd:9.8},{observedAt:2000,priceUsd:9.6}]).reason,'CONTINUING_PRICE_DROP');
  const stable=assessEntryStability([{observedAt:0,priceUsd:10},{observedAt:1000,priceUsd:9.9},{observedAt:2000,priceUsd:9.95}]);
  assert.equal(stable.stable,true); assert.equal(stable.reason,'STABLE_OR_RECOVERING');
});
test('candle history blocks a pump that already dumped and three red candles',()=>{
  const base=[{time:1,open:10,close:30,high:30,low:10,volume:1},{time:2,open:30,close:20,high:31,low:19,volume:1},{time:3,open:20,close:19,high:21,low:18,volume:1}];
  assert.equal(assessCandleHistory(base).reason,'PUMP_THEN_DUMP');
  assert.equal(assessCandleHistory([{time:1,open:10,close:9,high:10,low:9,volume:1},{time:2,open:9,close:8,high:9,low:8,volume:1},{time:3,open:8,close:7,high:8,low:7,volume:1}]).reason,'THREE_RED_CANDLES');
  assert.equal(assessCandleHistory([{time:1,open:10,close:11,high:11,low:10,volume:1}]).reason,'SINGLE_CANDLE_ONLY');
  const one = assessCandleHistory([{time:1,open:10,close:11,high:11,low:10,volume:1}]);
  assert.equal(assessSingleCandleHolderOverride(one, 101, true).allowed, true);
  assert.equal(assessSingleCandleHolderOverride(one, 100, true).reason, 'HOLDERS_NOT_ABOVE_100');
  assert.equal(assessSingleCandleHolderOverride(one, 150, false).reason, 'HOLDER_GROWTH_NOT_SIGNIFICANT_OR_FRESH');
  assert.equal(assessCandleHistory([{time:1,open:10,close:11,high:11,low:10,volume:1},{time:2,open:11,close:12,high:12,low:11,volume:1}]).allowed,false);
  assert.equal(assessCandleHistory([{time:1,open:10,close:14,high:14,low:10,volume:1},{time:2,open:14,close:8,high:14,low:8,volume:1},{time:3,open:8,close:9,high:9,low:8,volume:1}]).reason,'SHARP_CANDLE_CRASH');
  // Single rising candle with sufficient holders is allowed
  const greenCandle = [{time:1,open:10,close:12,high:12,low:10,volume:1}];
  assert.equal(assessEarlyCandleRising(greenCandle, one, null, 25, 20).allowed, true);
  assert.equal(assessEarlyCandleRising(greenCandle, one, null, 25, 20).reason, 'EARLY_CANDLE_RISING_OK');
  // Single red candle is blocked
  const redCandle = [{time:1,open:10,close:9,high:10,low:8,volume:1}];
  assert.equal(assessEarlyCandleRising(redCandle, one, null, 25, 20).allowed, false);
  assert.equal(assessEarlyCandleRising(redCandle, one, null, 25, 20).reason, 'CANDLE_NOT_RISING');
  // Single candle with drop flow is blocked
  assert.equal(assessEarlyCandleRising(greenCandle, one, { allowed: false, reason: 'CURRENT_CANDLE_DROP', completedCandles: 0, currentCandleReturnPercent: -6 }, 25, 20).allowed, false);
  // Single candle with low holders is blocked
  assert.equal(assessEarlyCandleRising(greenCandle, one, null, 15, 20).allowed, false);
  assert.equal(assessEarlyCandleRising(greenCandle, one, null, 15, 20).reason, 'INSUFFICIENT_HOLDERS');
});
test('Playwright adapter ignores other sockets and handles reconnect, binary JSON, malformed frames',()=>{
  const page=new EventEmitter(); const captured:unknown[]=[];const payloads:unknown[]=[];
  attachCapture(page as unknown as Page,e=>captured.push(e),(p)=>payloads.push(p));
  const make=(url:string)=>Object.assign(new EventEmitter(),{url:()=>url});
  const bad=make('wss://evil.example/v2/ws');page.emit('websocket',bad);bad.emit('framereceived',{payload:'{}'});
  assert.equal(captured.length,0);
  for(let i=0;i<2;i++) {
    const ws=make('wss://ws.gmgn.ai/v2/ws?device_id=PRIVATE');
    page.emit('websocket',ws);ws.emit('framesent',{payload:'{"channel":"subscribe"}'});
    ws.emit('framereceived',{payload:Buffer.from('{"channel":"chain_stat","data":[]}')});
    ws.emit('framereceived',{payload:'{broken'});ws.emit('close');
  }
  assert.equal(payloads.length,2);assert.ok(!JSON.stringify(captured).includes('PRIVATE'));
});
test('token activity parser retains only verified buy/sell facts',()=>{
  const [activity] = parseTokenActivities({ channel:'token_activity_info_all', data:[{
    n:'sol', a:mint, e:'sell', t:1789918167, pu:'0.0000040004537085628808', au:'6.42210181928', ad:'wallet-is-not-retained', h:'signature-is-not-retained',
  }]}, now);
  assert.deepEqual(activity, { mint, side:'sell', occurredAt:1789918167000, observedAt:now, priceUsd:0.0000040004537085628808, amount:6.42210181928 });
  assert.deepEqual(parseTokenActivities({channel:'token_activity_info_all',data:[{n:'sol',a:mint,e:'swap'}]},now),[]);
  assert.equal(parseTokenActivities({channel:'token_activity',data:[{n:'sol',a:mint,e:'buy',t:1}]},now)[0]?.side,'buy');
  const withActor = parseTokenActivities({channel:'token_activity_info_all',data:[{n:'sol',a:mint,e:'sell',ad:'11111111111111111111111111111111'}]},now)[0];
  assert.match(withActor?.actorHash ?? '', /^[a-f0-9]{16}$/);
  assert.equal(withActor?.actorAddress, '11111111111111111111111111111111');
});
test('blind protection blocks young tokens when holder API hits 429 or is unverified', () => {
  // Young token with 429 status is strictly blocked
  assert.equal(assessBlindProtection(true, 429, 0).allowed, false);
  assert.equal(assessBlindProtection(true, 429, 0).reason, 'BLIND_PROTECTION_HOLDERS_429');

  // Young token with 0 holders is blocked
  assert.equal(assessBlindProtection(true, 200, 0).allowed, false);
  assert.equal(assessBlindProtection(true, 200, 0).reason, 'BLIND_PROTECTION_NO_HOLDERS');

  // Young token with non-200 status (e.g. 500 or null) is blocked
  assert.equal(assessBlindProtection(true, null, 0).allowed, false);
  assert.equal(assessBlindProtection(true, null, 0).reason, 'BLIND_PROTECTION_NO_HOLDERS');

  // Young token with verified holders (status 200, count > 0) is allowed
  assert.equal(assessBlindProtection(true, 200, 48).allowed, true);
  assert.equal(assessBlindProtection(true, 200, 48).reason, 'HOLDERS_VERIFIED');

  // Mature token (candle 3+) is exempt
  assert.equal(assessBlindProtection(false, 429, 0).allowed, true);
  assert.equal(assessBlindProtection(false, 429, 0).reason, 'MATURE_TOKEN_EXEMPT');
});

