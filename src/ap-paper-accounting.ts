import { randomUUID } from 'node:crypto';
import type { ScenarioPosition, ScenarioState, ScenarioLogEvent } from './multi-scenario-dryrun-engine.js';
import type { WalletTradeSignal } from './wallet-follower-lane.js';

// PAPER estimate only: not an assertion about exchange/on-chain fee parity.
export const AP_PAPER_FEE = 0.025;
export const AP_ACCOUNTING_VERSION = 2;
export interface ApQuoteTicket {
  lane: string; mint: string; positionId: string; revision: number;
  requestId: string; side: 'BUY' | 'SELL'; tokens: number; baseUnits?: string;
  decimals?: number; pairAddress?: string; requestedAt: number;
}
export interface ApAccounting {
  version: 2; provenance: 'PAPER_AMM_QUOTE'; positionId: string; revision: number;
  status: 'BUY_PENDING' | 'BUY_UNAVAILABLE' | 'OPEN_UNPRICED' | 'OPEN_QUOTED' | 'EXIT_PENDING' | 'EXIT_UNAVAILABLE';
  cashOutlayUsd: number; buyFeeUsd: number; remainingBuyFeeUsd: number;
  grossReturnedUsd: number; netReturnedUsd: number; baseUnits?: string; decimals?: number;
  pending?: ApQuoteTicket; exitReason?: string; exitBaseUnits?: string; lastError?: string;
  attempts: number; lastAttemptAt?: number; lastFreshAt?: number;
}
export const isAp = (id: string) => ['SCENARIO_14_BUNDLER_RUNNER', 'SCENARIO_14_ALPHA_60S_GRACE',
  'SCENARIO_14_BETA_HOARDING_DEFENSE'].includes(id);
export function apEvent(s: ScenarioState, p: ScenarioPosition, action: ScenarioLogEvent['action'], reason: string,
  extra: Partial<ScenarioLogEvent> = {}, now = Date.now()): void {
  s.recentEvents.unshift({id:randomUUID(), timestamp:now, timeWib:new Date(now).toISOString(), scenarioId:s.id,
    action, mint:p.mint, symbol:p.symbol, priceUsd:p.lastPriceUsd, availableCashAfter:s.availableCash,
    investedCashAfter:s.openPositions.reduce((n,p)=>n+p.costBasisUsd,0), reason, ...extra});
  s.recentEvents = s.recentEvents.slice(0,50);
}
export function apTicket(s: ScenarioState, p: ScenarioPosition, side: 'BUY'|'SELL', tokens: number, baseUnits?: string): ApQuoteTicket {
  return {lane:s.id,mint:p.mint,positionId:p.ap!.positionId,revision:p.ap!.revision,requestId:randomUUID(),
    side,tokens,baseUnits,decimals:p.ap!.decimals,pairAddress:p.pairAddress,requestedAt:Date.now()};
}
export function matchesApTicket(s: ScenarioState, p: ScenarioPosition, ticket?: ApQuoteTicket): boolean {
  const pending = p.ap?.pending;
  return !!ticket && !!pending && ticket.lane===s.id && ticket.mint===p.mint &&
    ticket.positionId===p.ap!.positionId && ticket.revision===p.ap!.revision &&
    ticket.requestId===pending.requestId && ticket.side===pending.side && ticket.tokens===pending.tokens &&
    ticket.baseUnits===pending.baseUnits && ticket.pairAddress===p.pairAddress;
}
export function reserveApBuy(s: ScenarioState, signal: WalletTradeSignal, stake: number, now: number): ScenarioPosition {
  s.availableCash -= stake + AP_PAPER_FEE;
  const p: ScenarioPosition = {mint:signal.mint,symbol:signal.symbol,tokenName:signal.tokenName,openedAt:now,
    updatedAt:now,entryCount:1,tokens:0,costBasisUsd:stake,avgEntryPriceUsd:0,lastPriceUsd:signal.priceUsd,
    unrealizedPnlUsd:0,realizedPnlUsd:0,peakTargetHolding:signal.remainingHolding,feesPaidUsd:0,
    pairAddress:signal.pairAddress||'',exchange:signal.exchange||'',initialCostBasisUsd:stake,
    ap:{version:2,provenance:'PAPER_AMM_QUOTE',positionId:randomUUID(),revision:0,status:'BUY_PENDING',
      cashOutlayUsd:stake+AP_PAPER_FEE,buyFeeUsd:AP_PAPER_FEE,remainingBuyFeeUsd:AP_PAPER_FEE,
      grossReturnedUsd:0,netReturnedUsd:0,attempts:0}};
  p.ap!.pending = apTicket(s,p,'BUY',0);
  s.openPositions.unshift(p);
  apEvent(s,p,'BUY_INTENT','BUY_PENDING — reserved, not filled',{stakeUsd:stake,tokens:0,feeUsd:0});
  return p;
}
export function settleApBuy(s: ScenarioState, p: ScenarioPosition, price: number, tokens: number, stake: number,
  ticket?: ApQuoteTicket & {baseUnits?:string;decimals?:number}): boolean {
  // BUY response carries output base units, not input quantity.
  if (!ticket || !matchesApTicket(s,p,{...ticket,baseUnits:undefined}) || ticket.side!=='BUY' ||
    p.ap!.status!=='BUY_PENDING' || !Number.isFinite(price) || price<=0 || !Number.isFinite(tokens) || tokens<=0 ||
    stake!==p.costBasisUsd || !ticket.baseUnits || !/^\d+$/.test(ticket.baseUnits) || BigInt(ticket.baseUnits)<=0n ||
    !Number.isInteger(ticket.decimals) || ticket.decimals!<0 || ticket.decimals!>18 ||
    Math.abs(Number(ticket.baseUnits)/10**ticket.decimals!-tokens)>Math.max(1e-12,tokens*1e-12)) return false;
  p.tokens=tokens; p.initialTokens=tokens; p.avgEntryPriceUsd=stake/tokens; p.lastPriceUsd=p.avgEntryPriceUsd;
  p.feesPaidUsd=AP_PAPER_FEE; s.totalFeesPaid+=AP_PAPER_FEE;
  p.ap!.baseUnits=ticket.baseUnits; p.ap!.decimals=ticket.decimals;
  p.ap!.pending=undefined; p.ap!.revision++; p.ap!.status='OPEN_UNPRICED';
  s.apBoughtMints ||= []; if (!s.apBoughtMints.includes(p.mint)) s.apBoughtMints.push(p.mint);
  apEvent(s,p,'BUY','BUY_QUOTE_SETTLED (probe 2)',{stakeUsd:stake,tokens,feeUsd:AP_PAPER_FEE,priceUsd:p.avgEntryPriceUsd});
  return true;
}

export function beginApExit(s: ScenarioState, p: ScenarioPosition, reason: string, partial = false): ApQuoteTicket | undefined {
  const a=p.ap;
  if (!a || a.status.startsWith('BUY') || a.status==='EXIT_PENDING' || p.tokens<=0 || !a.baseUnits ||
    (partial && p.stage1Exited)) return;
  const units=partial ? BigInt(a.baseUnits)/2n : BigInt(a.baseUnits);
  if (units<=0n) return;
  const tokens=Number(units)/10**a.decimals!;
  a.pending=apTicket(s,p,'SELL',tokens,units.toString());
  a.status='EXIT_PENDING'; a.exitReason=reason; a.exitBaseUnits=units.toString();
  apEvent(s,p,'SELL_INTENT',reason,{tokens,feeUsd:0});
  return a.pending;
}
export function failApExit(s: ScenarioState, p: ScenarioPosition, error: string, ticket?: ApQuoteTicket): boolean {
  if (!matchesApTicket(s,p,ticket) || ticket!.side!=='SELL') return false;
  p.ap!.status='EXIT_UNAVAILABLE'; p.ap!.lastError=error;
  apEvent(s,p,'SKIP',`EXIT_UNAVAILABLE: ${error}`);
  return true;
}
export function abortApBuy(s: ScenarioState, p: ScenarioPosition, error: string, ticket?: ApQuoteTicket): boolean {
  if (!matchesApTicket(s,p,ticket) || ticket!.side!=='BUY' || !p.ap!.status.startsWith('BUY')) return false;
  s.availableCash+=p.ap!.cashOutlayUsd;
  s.openPositions.splice(s.openPositions.indexOf(p),1);
  apEvent(s,p,'SKIP',`BUY_ROUTE_FAILED: ${error} — reservation refunded once`);
  return true;
}
export function settleApSell(s: ScenarioState, p: ScenarioPosition, price: number, gross: number, reason: string,
  ticket?: ApQuoteTicket): boolean {
  if (!matchesApTicket(s,p,ticket) || ticket!.side!=='SELL' || !Number.isFinite(gross) || gross<=0 ||
    !Number.isFinite(price) || price<=0 || Date.now()-ticket!.requestedAt>5000) return false;
  const a=p.ap!, before=BigInt(a.baseUnits!), sold=BigInt(ticket!.baseUnits!);
  if (sold<=0n || sold>before) return false;
  const ratio=Number(sold)/Number(before), principal=p.costBasisUsd*ratio, buyFee=a.remainingBuyFeeUsd*ratio;
  const net=gross-AP_PAPER_FEE, pnl=net-principal-buyFee;
  s.availableCash+=net; s.totalFeesPaid+=AP_PAPER_FEE; s.realizedPnl+=pnl;
  p.costBasisUsd-=principal; a.remainingBuyFeeUsd-=buyFee;
  a.grossReturnedUsd+=gross; a.netReturnedUsd+=net;
  p.feesPaidUsd+=AP_PAPER_FEE; p.realizedPnlUsd+=pnl;
  a.baseUnits=(before-sold).toString(); p.tokens=Number(before-sold)/10**a.decimals!;
  a.pending=undefined; a.revision++; a.status='OPEN_UNPRICED'; a.lastFreshAt=Date.now(); a.lastError=undefined;
  a.exitReason=undefined; a.exitBaseUnits=undefined;
  p.updatedAt=Date.now(); p.lastPriceUsd=price;
  apEvent(s,p,'SELL',`${reason} — SELL_QUOTE_SETTLED`,{tokens:ticket!.tokens,usdReceived:net,feeUsd:AP_PAPER_FEE,pnlUsd:pnl,priceUsd:price});
  if (sold<before) {
    p.stage1Exited=true; p.stage1ExitedAt=Date.now(); p.stage1RealUsdReturned=net;
  } else {
    s.openPositions.splice(s.openPositions.indexOf(p),1);
    const isWin=p.realizedPnlUsd>=0;
    if (isWin) s.wins++; else s.losses++;
    s.totalTrades++;
    s.closedTrades.unshift({mint:p.mint,symbol:p.symbol,tokenName:p.tokenName,openedAt:p.openedAt,closedAt:Date.now(),
      entryCount:p.entryCount,totalInvestedUsd:p.initialCostBasisUsd!,cashOutlayUsd:a.cashOutlayUsd,
      totalReturnedUsd:a.netReturnedUsd,totalFeesPaidUsd:p.feesPaidUsd,realizedPnlUsd:p.realizedPnlUsd,
      roiPct:p.realizedPnlUsd/a.cashOutlayUsd*100,exitReason:reason,isWin,stage1RealUsdReturned:p.stage1RealUsdReturned,
      accountingVersion:2,provenance:'PAPER_AMM_QUOTE'});
    s.closedTrades=s.closedTrades.slice(0,100);
  }
  return true;
}
