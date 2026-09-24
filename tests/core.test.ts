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
import { TabManager } from '../src/tab-manager.js';
import { assessExit } from '../src/positions.js';
import { attachCapture } from '../src/capture.js';
import { parseTokenActivities } from '../src/activity.js';
import { assessPumpBandDump, isInPumpBand, latestPricedTradeInFrame, pumpMilestones } from '../src/pump-band.js';
import { assessBlindProtection, assessCandleHistory, assessEarlyCandleRising, assessEntryStability, assessFlow3EntryStability, assessFlow3Simulation, assessHolderDistribution, assessObservationDump, assessSimulation, assessSingleCandleHolderOverride, openSimulation, type SimulationExitReason } from '../src/research-simulation.js';
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
test('pump-band keeps only the $3k-$10k cohort and closes a 20% peak drawdown', () => {
  assert.equal(isInPumpBand(3_000), true);
  assert.equal(isInPumpBand(2_999), false);
  assert.equal(isInPumpBand(10_000), true);
  assert.equal(isInPumpBand(10_001), false);
  assert.equal(assessPumpBandDump(3_000, 8_000, 6_300).dump, true);
  assert.deepEqual(pumpMilestones([
    { observedAt: 1_000, marketCapUsd: 3_000, priceUsd: null },
    { observedAt: 3_000, marketCapUsd: 6_100, priceUsd: null },
    { observedAt: 7_000, marketCapUsd: 10_100, priceUsd: null },
  ], 1_000), { '6000': 2_000, '8000': 6_000, '10000': 6_000 });
});
test('pump-band uses only the latest price in a received activity frame', () => {
  const latest = latestPricedTradeInFrame([
    { occurredAt: 1000, priceUsd: 10 },
    { occurredAt: 3000, priceUsd: 14 },
    { occurredAt: 2000, priceUsd: 7 },
    { occurredAt: 4000, priceUsd: null },
  ]);
  assert.equal(latest?.priceUsd, 14);
  assert.equal(latest?.occurredAt, 3000);
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
test('flow-3 keeps only its documented target, stop, trailing, and sell-pressure exits',()=>{
  const noTieredExit=openSimulation(mint,now,10);
  assessFlow3Simulation(noTieredExit,12.5,{buys:3,sells:1,buyUsd:10,sellUsd:1,uniqueSellers:1});
  assert.equal(assessFlow3Simulation(noTieredExit,11.7,{buys:2,sells:2,buyUsd:10,sellUsd:10,uniqueSellers:1}).exitReason,null);
  const trailing=openSimulation(mint,now,10);
  assessFlow3Simulation(trailing,12.1,{buys:1,sells:1,buyUsd:1,sellUsd:1,uniqueSellers:1});
  assert.equal(assessFlow3Simulation(trailing,10.8,{buys:1,sells:1,buyUsd:1,sellUsd:1,uniqueSellers:1}).exitReason,'TRAILING_10');
  const stopped=openSimulation(mint,now,10);
  assert.equal(assessFlow3Simulation(stopped,8,{buys:0,sells:0,buyUsd:0,sellUsd:0,uniqueSellers:0}).exitReason,'STOP_LOSS_20');
});
test('flow-3 blocks a 2% drop or two consecutive declines at entry',()=>{
  const now=Date.now();
  assert.equal(assessFlow3EntryStability([{observedAt:now-4000,priceUsd:1},{observedAt:now-2000,priceUsd:0.995},{observedAt:now,priceUsd:0.979}]).reason,'CONTINUING_PRICE_DROP');
  assert.equal(assessFlow3EntryStability([{observedAt:now-4000,priceUsd:1},{observedAt:now-2000,priceUsd:0.999},{observedAt:now,priceUsd:0.998}]).reason,'CONTINUING_PRICE_DROP');
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
  const withTraderAndAuxiliary = parseTokenActivities({channel:'token_activity_info_all',data:[{
    n:'sol',a:mint,e:'buy',m:'11111111111111111111111111111111',ad:'So11111111111111111111111111111111111111112',
  }]},now)[0];
  assert.equal(withTraderAndAuxiliary?.actorAddress, '11111111111111111111111111111111');
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

test('tiered holder distribution gate checks 20-39 holders for strict balance and allows >= 40 holders with standard limits', () => {
  // Below 20 holders is strictly rejected
  const under20 = assessHolderDistribution(18, 5, 15, 0);
  assert.equal(under20.allowed, false);
  assert.equal(under20.action, 'REJECT');
  assert.equal(under20.reason, 'HOLDERS_BELOW_20');

  // Range 20-39: Dominated by single wallet (Top 1 > 10%) triggers WAIT_FOR_DILUTION ("Nanti Dulu")
  const earlyDominatedTop1 = assessHolderDistribution(25, 15.5, 30.0, 0);
  assert.equal(earlyDominatedTop1.allowed, false);
  assert.equal(earlyDominatedTop1.action, 'WAIT_FOR_DILUTION');
  assert.ok(earlyDominatedTop1.reason.includes('EARLY_HOLDERS_DOMINATED'));

  // Range 20-39: Dominated by Top 5 (> 32%) triggers WAIT_FOR_DILUTION
  const earlyDominatedTop5 = assessHolderDistribution(28, 8.0, 38.5, 0);
  assert.equal(earlyDominatedTop5.allowed, false);
  assert.equal(earlyDominatedTop5.action, 'WAIT_FOR_DILUTION');

  // Range 20-39: Dominated by dev (> 2%) triggers WAIT_FOR_DILUTION
  const earlyDevDominated = assessHolderDistribution(30, 8.0, 25.0, 3.5);
  assert.equal(earlyDevDominated.allowed, false);
  assert.equal(earlyDevDominated.action, 'WAIT_FOR_DILUTION');

  // Range 20-39: Highly balanced/merata is ALLOWED to buy early
  const earlyBalanced = assessHolderDistribution(32, 7.5, 22.0, 0.5);
  assert.equal(earlyBalanced.allowed, true);
  assert.equal(earlyBalanced.action, 'BUY');
  assert.equal(earlyBalanced.reason, 'EARLY_DISTRIBUTION_BALANCED');

  // Range >= 40: Standard limits applied, concentrated supply (Top 1 > 20%) is rejected
  const matureConcentratedTop1 = assessHolderDistribution(55, 25.0, 48.0, 0);
  assert.equal(matureConcentratedTop1.allowed, false);
  assert.equal(matureConcentratedTop1.action, 'REJECT');
  assert.ok(matureConcentratedTop1.reason.includes('CONCENTRATED_SUPPLY'));

  // Range >= 40: Concentrated Top 5 (> 50%) is rejected
  const matureConcentratedTop5 = assessHolderDistribution(60, 15.0, 55.0, 0);
  assert.equal(matureConcentratedTop5.allowed, false);
  assert.equal(matureConcentratedTop5.action, 'REJECT');

  // Range >= 40: Healthy established distribution is allowed to buy
  const matureHealthy = assessHolderDistribution(75, 12.0, 35.0, 1.0);
  assert.equal(matureHealthy.allowed, true);
  assert.equal(matureHealthy.action, 'BUY');
  assert.equal(matureHealthy.reason, 'ESTABLISHED_DISTRIBUTION_OK');
});

test('simulation exit triggers breakeven guard, tiered trailing stop, and early cut loss', () => {
  const pos = openSimulation(mint, now, 1.0, 100);

  // 1. Breakeven guard: Reached peak +6%, then drops down to +0.4% -> triggers BREAKEVEN_GUARD
  assessSimulation(pos, 1.06, { buys: 5, sells: 2, buyUsd: 100, sellUsd: 20, uniqueSellers: 1 });
  const breakevenDecision = assessSimulation(pos, 1.004, { buys: 2, sells: 2, buyUsd: 20, sellUsd: 20, uniqueSellers: 1 });
  assert.equal(breakevenDecision.exitReason, 'BREAKEVEN_GUARD');

  // 2. Tiered trailing stop: Peak +25%, draws down 6.5% -> triggers TRAILING_TIERED
  const pos2 = openSimulation(mint, now, 1.0, 100);
  assessSimulation(pos2, 1.25, { buys: 10, sells: 1, buyUsd: 500, sellUsd: 10, uniqueSellers: 1 });
  // Price draws down by 6.5% from 1.25 -> 1.25 * (1 - 0.065) = 1.16875
  const tieredDecision = assessSimulation(pos2, 1.168, { buys: 2, sells: 2, buyUsd: 20, sellUsd: 20, uniqueSellers: 1 });
  assert.equal(tieredDecision.exitReason, 'TRAILING_TIERED');

  // 3. Early cut loss: Price drops to -8.5% with sell pressure -> triggers EARLY_CUT_LOSS
  const pos3 = openSimulation(mint, now, 1.0, 100);
  const earlyCutDecision = assessSimulation(pos3, 0.915, { buys: 10, sells: 15, buyUsd: 20, sellUsd: 100, uniqueSellers: 4, windowStart: 100 });
  assert.equal(earlyCutDecision.exitReason, 'EARLY_CUT_LOSS');
});

test('auto close monitoring aborts observation early when token dumps heavily (e.g. locus scenario)', () => {
  // 1. Locus scenario: Live 1m candle crashed -52.25%
  const locusCandleDump = assessObservationDump({
    currentPriceUsd: 0.00000391,
    openingPriceUsd: 0.00000391,
    peakPriceUsd: 0.00001025,
    candleEntryFlow: {
      allowed: false,
      reason: 'INSUFFICIENT_COMPLETED_CANDLES',
      completedCandles: 1,
      currentCandleReturnPercent: -52.25,
    },
    sampleCount: 3,
    tradesCount: 20,
  });
  assert.equal(locusCandleDump.shouldAbort, true);
  assert.equal(locusCandleDump.reason, 'CANDLE_DUMP');
  assert.equal(locusCandleDump.drawdownPercent, 52.25);

  // 2. Price drop from peak: Price drops from $0.000010 to $0.0000065 (-35% from peak)
  const peakDrop = assessObservationDump({
    currentPriceUsd: 0.0000065,
    openingPriceUsd: 0.000008,
    peakPriceUsd: 0.000010,
    sampleCount: 5,
    tradesCount: 15,
  });
  assert.equal(peakDrop.shouldAbort, true);
  assert.equal(peakDrop.reason, 'PRICE_DROP_FROM_PEAK');
  assert.equal(peakDrop.drawdownPercent, 35);

  // 3. Price drop from opening price: Dropped 22% below open
  const openDrop = assessObservationDump({
    currentPriceUsd: 0.0000078,
    openingPriceUsd: 0.000010,
    peakPriceUsd: 0.000010,
    stopLossPercent: 20,
    sampleCount: 4,
    tradesCount: 10,
  });
  assert.equal(openDrop.shouldAbort, true);
  assert.equal(openDrop.reason, 'PRICE_DROP_FROM_OPEN');
  assert.equal(openDrop.drawdownPercent, 22);

  // 4. Pump then dump candle history
  const pumpDump = assessObservationDump({
    currentPriceUsd: 0.000008,
    openingPriceUsd: 0.000008,
    peakPriceUsd: 0.000008,
    candleDecision: {
      allowed: false,
      reason: 'PUMP_THEN_DUMP',
      peakToLastDrawdownPercent: -45.0,
      consecutiveRedCandles: 2,
      largestGreenCandlePercent: 120,
      largestRedCandlePercent: -25,
    },
  });
  assert.equal(pumpDump.shouldAbort, true);
  assert.equal(pumpDump.reason, 'PUMP_THEN_DUMP');

  // 5. Heavy sell avalanche: 20 trades, sellUsd 1500 vs buyUsd 100 (buyShare 6%)
  const avalanche = assessObservationDump({
    currentPriceUsd: 0.000009,
    openingPriceUsd: 0.000010,
    peakPriceUsd: 0.000010,
    tradeFlow: {
      trades: 20,
      buys: 2,
      sells: 18,
      buyUsd: 100,
      sellUsd: 1500,
      buySharePercent: 6.25,
    },
  });
  assert.equal(avalanche.shouldAbort, true);
  assert.equal(avalanche.reason, 'HEAVY_SELL_AVALANCHE');

  // 6. Healthy rising token should NOT abort
  const healthy = assessObservationDump({
    currentPriceUsd: 0.000011,
    openingPriceUsd: 0.000010,
    peakPriceUsd: 0.0000112,
    candleEntryFlow: {
      allowed: true,
      reason: 'CANDLE_ENTRY_FLOW_OK',
      completedCandles: 3,
      currentCandleReturnPercent: 8.5,
    },
    tradeFlow: {
      trades: 15,
      buys: 10,
      sells: 5,
      buyUsd: 800,
      sellUsd: 300,
      buySharePercent: 72.7,
    },
    sampleCount: 5,
    tradesCount: 15,
  });
  assert.equal(healthy.shouldAbort, false);
  assert.equal(healthy.reason, null);
});

test('tab manager enforces 5-tab limit, monitors active tabs, preserves closed history, and supports reopen', () => {
  const tm = new TabManager(5);
  assert.equal(tm.getActiveCount(), 0);
  assert.equal(tm.canOpen(), true);

  // Open 5 tabs
  assert.ok(tm.openTab('mint1', 'TK1', 'https://gmgn.ai/sol/token/mint1', 'Token 1', 1000));
  assert.ok(tm.openTab('mint2', 'TK2', 'https://gmgn.ai/sol/token/mint2', 'Token 2', 1000));
  assert.ok(tm.openTab('mint3', 'TK3', 'https://gmgn.ai/sol/token/mint3', 'Token 3', 1000));
  assert.ok(tm.openTab('mint4', 'TK4', 'https://gmgn.ai/sol/token/mint4', 'Token 4', 1000));
  assert.ok(tm.openTab('mint5', 'TK5', 'https://gmgn.ai/sol/token/mint5', 'Token 5', 1000));

  assert.equal(tm.getActiveCount(), 5);
  assert.equal(tm.canOpen(), false);

  // 6th tab cannot open
  assert.equal(tm.openTab('mint6', 'TK6', 'https://gmgn.ai/sol/token/mint6', 'Token 6', 1000), false);

  // Close tab mint2
  const closed = tm.closeTab('mint2', 1000 + 45000);
  assert.ok(closed);
  assert.equal(closed.mint, 'mint2');
  assert.equal(closed.symbol, 'TK2');
  assert.equal(closed.durationSeconds, 45);
  assert.equal(closed.index, 1);

  // Now active count is 4, slot is free
  assert.equal(tm.getActiveCount(), 4);
  assert.equal(tm.canOpen(), true);

  // Closed history contains mint2
  const history = tm.getClosedHistory();
  assert.equal(history.length, 1);
  assert.equal(history[0].symbol, 'TK2');

  // Reopen by index #1
  const reopenResult = tm.reopenTab(1, 2000);
  assert.equal(reopenResult.success, true);
  assert.equal(reopenResult.item?.symbol, 'TK2');
  assert.equal(tm.getActiveCount(), 5);
  assert.equal(tm.canOpen(), false);
  assert.equal(tm.getClosedHistory().length, 0); // removed from closed history
});

test('1-tab mode: tab manager enforces 1-tab limit, records metrics, and queue takes newest candidate', () => {
  const tm = new TabManager(1);
  assert.equal(tm.getMaxTabs(), 1);
  assert.equal(tm.canOpen(), true);

  assert.ok(tm.openTab('mintA', 'TKA', 'https://gmgn.ai/sol/token/mintA', 'Token A', 1000));
  assert.equal(tm.getActiveCount(), 1);
  assert.equal(tm.canOpen(), false);

  // Second tab cannot open concurrently
  assert.equal(tm.openTab('mintB', 'TKB', 'https://gmgn.ai/sol/token/mintB', 'Token B', 1000), false);

  // Update token metrics & holder distribution
  tm.updateTokenMetrics('mintA', {
    top10Percent: 22.5,
    developerPercent: 0,
    marketCapUsd: 150000,
    liquidityUsd: 35000,
  });
  const active = tm.getActiveTabs()[0];
  assert.equal(active.top10Percent, 22.5);
  assert.equal(active.retailPercent, 77.5);

  // Record trades and check buyRatioPercent
  tm.recordTrade('mintA', { side: 'buy', amountUsd: 750, priceUsd: 0.0001, occurredAt: 1050 });
  tm.recordTrade('mintA', { side: 'sell', amountUsd: 250, priceUsd: 0.0001, occurredAt: 1100 });
  assert.equal(active.buyRatioPercent, 75);
  assert.equal(active.netFlowUsd, 500);

  // Queue takes newest candidate
  const q = new CandidateQueue(10, 60000);
  const now = 100000;
  q.push('token1', now);
  q.push('token2', now + 10);
  q.push('token3', now + 20); // newest / last inserted
  assert.equal(q.take(now + 20), 'token3');

  // Close active tab
  const closed = tm.closeTab('mintA', 1500);
  assert.ok(closed);
  assert.equal(closed.top10Percent, 22.5);
  assert.equal(closed.buyRatioPercent, 75);
  assert.equal(tm.getActiveCount(), 0);
  assert.equal(tm.canOpen(), true);
});
