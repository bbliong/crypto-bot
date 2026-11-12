import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { MultiScenarioDryRunEngine } from '../src/multi-scenario-dryrun-engine.ts';

export function fixture(key = 's14') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ap-net10-account-'));
  const engine = new MultiScenarioDryRunEngine(dir);
  engine.startBundlerResearchTracker = () => {};
  engine.queryGmgnTokenStatRaw = async () => null;
  engine.bundlerResolver = async () => null;
  const scenario = engine.scenarios[key];
  const signal = { action:'buy', mint:'OfflineMint', symbol:'FIX', tokenName:'FIX', tokenAmount:70e6,
    remainingHolding:70e6, solAmount:30, usdAmount:2700, priceUsd:0.00001,
    timestamp:Math.floor(Date.now()/1000), txHash:'fixture', isFirstBuy:true, pairAddress:'OfflinePair', exchange:'fixture' };
  const calls = [];
  engine.onTradeAction = (...args) => { calls.push(args); };
  const buy = () => engine.processScenarioBuy(scenario, signal, true, 2700, Date.now(), 'fixture',
    {maxTokenExposure:5, getStake:()=>5, allowReEntryCycle:true});
  return {dir, engine, scenario, signal, calls, buy};
}

test('AP BUY reserves affordable principal, but has no spot fill or SELL before exact quote settlement', () => {
  const {engine, scenario:s, signal, calls, buy} = fixture();
  buy();
  const p = s.openPositions[0];
  assert.equal(p.tokens, 0, 'pending BUY must not expose fabricated spot quantity');
  assert.equal(p.ap.status, 'BUY_PENDING');
  assert.equal(s.availableCash, 0);
  assert.equal(s.totalFeesPaid, 0, 'fee is reserved, not yet paid');
  assert.equal(s.totalPortfolioValue,5,'pending reservation is not a paid fee or liquidatable spot holding');
  assert.equal(calls[0][3].stakeUsd, 4.975);
  assert.equal(s.recentEvents[0].action, 'BUY_INTENT');
  engine.updatePriceTick(signal.mint, 0.01);
  engine.executeScenarioExit(s, 0, 0.01, Date.now(), 'fixture', 'TEST');
  assert.equal(calls.length, 1);
  assert.equal(s.closedTrades.length, 0);
  const ticket = calls[0][3].quoteTicket;
  engine.syncRealBuyExecution(s.id, signal.mint, 0.00002, 248750, 4.975, {...ticket, baseUnits:'248750000000', decimals:6});
  assert.equal(p.tokens, 248750);
  assert.equal(p.costBasisUsd, 4.975);
  assert.equal(p.ap.cashOutlayUsd, 5);
  assert.equal(p.ap.status, 'OPEN_UNPRICED');
  assert.equal(s.totalFeesPaid, .025);
  engine.syncRealBuyExecution(s.id, signal.mint, 1, 1, 4.975, ticket);
  assert.equal(p.tokens, 248750, 'duplicate callback ignored');
});

function filled(f) {
  f.buy(); const ticket=f.calls[0][3].quoteTicket;
  f.engine.syncRealBuyExecution(f.scenario.id,f.signal.mint, .00002,248750,4.975,
    {...ticket,baseUnits:'248750000000',decimals:6});
  return f.scenario.openPositions[0];
}
const near = (a,b) => assert.ok(Math.abs(a-b)<1e-10, `${a} != ${b}`);

test('AP partial + full SELL is intent only, failure keeps exposure, exact callbacks settle fees once', () => {
  const f=fixture(), {engine:e,scenario:s,calls}=f; const p=filled(f);
  e.executeScenarioPartial50Exit(s,0,.00003,Date.now(),'fixture','STAGE_1_TP_50%');
  assert.equal(s.availableCash,0,'no spot proceeds on intent');
  assert.equal(p.tokens,248750);
  const ticket=calls.at(-1)[3].quoteTicket;
  assert.equal(ticket.baseUnits,'124375000000');
  e.recordFailedSellExecution(s.id,p.mint,'NO_ROUTE',ticket);
  assert.equal(p.ap.status,'EXIT_UNAVAILABLE');
  assert.equal(s.closedTrades.length,0);
  e.syncRealSellExecution(s.id,p.mint,.00003,3.73125,'STAGE_1_TP_50%',{...ticket,revision:999});
  assert.equal(s.availableCash,0,'stale revision rejected');
  e.syncRealSellExecution(s.id,p.mint,.00003,3.73125,'STAGE_1_TP_50%',ticket);
  near(s.availableCash,3.70625); near(p.costBasisUsd,2.4875); near(p.tokens,124375);
  near(p.realizedPnlUsd,1.20625); near(s.totalFeesPaid,.05);
  e.syncRealSellExecution(s.id,p.mint,.00003,3.73125,'STAGE_1_TP_50%',ticket);
  near(s.availableCash,3.70625);
  e.executeScenarioExit(s,0,.00004,Date.now(),'fixture','FULL');
  assert.equal(s.closedTrades.length,0);
  const full=calls.at(-1)[3].quoteTicket;
  e.syncRealSellExecution(s.id,p.mint,.00004,4.975,'FULL',full);
  near(s.availableCash,8.65625); near(s.realizedPnl,3.65625); near(s.totalFeesPaid,.075);
  const t=s.closedTrades[0];
  near(t.totalInvestedUsd,4.975); near(t.cashOutlayUsd,5); near(t.totalReturnedUsd,8.65625);
  near(t.realizedPnlUsd,3.65625); near(t.totalFeesPaidUsd,.075);
  assert.equal(t.accountingVersion,2);
  e.syncRealSellExecution(s.id,p.mint,.00004,4.975,'FULL',full);
  e.recordFailedSellExecution(s.id,p.mint,'late error',full);
  near(s.availableCash,8.65625); near(s.realizedPnl,3.65625);
});

test('AP failed buy refunds once; no quote callback can rewrite legacy closed history', () => {
  const f=fixture(); f.buy(); const {engine:e,scenario:s,signal}=f;
  const ticket=f.calls[0][3].quoteTicket;
  e.abortScenarioBuy(s.id,signal.mint,'probe 2 threw',ticket);
  near(s.availableCash,5); assert.equal(s.openPositions.length,0); near(s.totalFeesPaid,0);
  e.abortScenarioBuy(s.id,signal.mint,'duplicate',ticket); near(s.availableCash,5);
  s.closedTrades.push({mint:signal.mint,totalReturnedUsd:12,realizedPnlUsd:7});
  const before=JSON.stringify(s.closedTrades);
  e.recordFailedSellExecution(s.id,signal.mint,'NO_ROUTE');
  e.syncRealSellExecution(s.id,signal.mint,1,1,'late');
  e.abortScenarioBuy(s.id,signal.mint,'late');
  assert.equal(JSON.stringify(s.closedTrades),before);
});

test('AP restart preserves unresolved SELL + durable no-rebuy after history trimming', () => {
  const f=fixture(); const p=filled(f), {engine:e,scenario:s}=f;
  e.executeScenarioExit(s,0,.00002,Date.now(),'fixture','FULL');
  const old=f.calls.at(-1)[3].quoteTicket;
  const loaded=new MultiScenarioDryRunEngine(f.dir), ls=loaded.scenarios.s14;
  assert.equal(ls.openPositions.length,1); assert.equal(ls.availableCash,0);
  loaded.syncRealSellExecution(s.id,p.mint,.00002,5,'FULL',old);
  assert.equal(ls.availableCash,0,'pre-restart callback invalidated');
  loaded.executeScenarioExit(ls,0,.00002,Date.now(),'fixture','FULL');
  loaded.syncRealSellExecution(s.id,p.mint,.00002,5,'FULL',ls.openPositions[0].ap.pending);
  ls.closedTrades=[]; loaded.saveState();
  const again=new MultiScenarioDryRunEngine(f.dir); let buys=0; again.onTradeAction=()=>{buys++};
  again.processScenarioBuy(again.scenarios.s14,f.signal,true,2700,Date.now(),'fixture',
    {maxTokenExposure:5,getStake:()=>5,allowReEntryCycle:true});
  assert.equal(buys,0); assert.match(again.scenarios.s14.recentEvents[0].reason,/REJECT_ALREADY_TRADED/);
});
