// Re-audit saved quotes, not new trades or alternative fills. Network is an explicit scenario.
export const NETWORK_SOL_PER_LEG=.000205;
const finitePositive=x=>typeof x==='number'&&Number.isFinite(x)&&x>0;
const integer=x=>{try{const n=BigInt(x);return n>0n?n:null;}catch{return null;}};
export function inspectStoredQuote(r){
  const b=r.buyQuote,s=r.sellQuote;
  if(!r.paired||!b||!s)return {status:'MISSING_PAIR',pnl:null};
  const buy=integer(b.inAmount),bought=integer(b.outAmount),sold=integer(s.inAmount),sell=integer(s.outAmount);
  if(!buy||!bought||!sold||!sell||b.inDecimals!==9||s.outDecimals!==9||b.outDecimals!==s.inDecimals||bought!==sold||!finitePositive(b.inUsd))
    return {status:'INVALID_PAIR',pnl:null};
  const buySol=Number(buy)/1e9,sellSol=Number(sell)/1e9,solUsd=b.inUsd/buySol;
  if(![buySol,sellSol,solUsd].every(finitePositive))return {status:'INVALID_PAIR',pnl:null};
  const ordering=Number.isFinite(b.at)&&Number.isFinite(s.at)&&Number.isFinite(r.exitAt)&&b.at<=r.exitAt&&s.at>=b.at;
  return {status:ordering?'ORDERED_QUOTE_PAIR':'QUOTE_ORDERING_WARNING',pnl:(sellSol-buySol-2*NETWORK_SOL_PER_LEG)*solUsd,
    doubleNetworkPnl:(sellSol-buySol-4*NETWORK_SOL_PER_LEG)*solUsd,
    exitHaircut1Pnl:(sellSol*.99-buySol-2*NETWORK_SOL_PER_LEG)*solUsd,
    cost:b.inUsd+NETWORK_SOL_PER_LEG*solUsd,solUsd,buyAt:b.at,sellAt:s.at,
    routePnl:(sellSol-buySol)*solUsd};
}
export function summarizeStoredQuotes(rows){
  const known=rows.filter(r=>r.q.pnl!==null),ordered=known.filter(r=>r.q.status==='ORDERED_QUOTE_PAIR');
  const missing=rows.filter(r=>r.q.pnl===null),warnings=known.filter(r=>r.q.status==='QUOTE_ORDERING_WARNING');
  const sum=(xs,key)=>xs.reduce((a,r)=>a+r.q[key],0);
  const winners=[...known].filter(r=>r.q.pnl>0).sort((a,b)=>b.q.pnl-a.q.pnl);
  const orderedWinners=[...ordered].filter(r=>r.q.pnl>0).sort((a,b)=>b.q.pnl-a.q.pnl);
  // Missing conversion cannot price a network fee: explicit stake-only partial downside proxy.
  const downsideStakeProxy=ordered.reduce((a,r)=>a+r.q.pnl,0)-missing.reduce((a,r)=>a+r.stake,0)-warnings.reduce((a,r)=>a+r.stake,0);
  return {entries:rows.length,paired:known.length,missingOrInvalid:missing.length,orderingWarnings:warnings.length,
    knownQuoteWins:known.filter(r=>r.q.pnl>0).length,knownQuoteLosses:known.filter(r=>r.q.pnl<0).length,
    knownQuotedNet:sum(known,'pnl'),orderedPairs:ordered.length,orderedQuotedNet:sum(ordered,'pnl'),
    knownDoubleNetworkNet:sum(known,'doubleNetworkPnl'),orderedDoubleNetworkNet:sum(ordered,'doubleNetworkPnl'),
    knownExitHaircut1Net:sum(known,'exitHaircut1Pnl'),orderedExitHaircut1Net:sum(ordered,'exitHaircut1Pnl'),
    knownWithoutTop3:sum(known,'pnl')-sum(winners.slice(0,3),'pnl'),
    orderedWithoutTop3:sum(ordered,'pnl')-sum(orderedWinners.slice(0,3),'pnl'),
    missingStake:missing.reduce((a,r)=>a+r.stake,0),downsideStakeProxy,
    days:new Set(rows.map(r=>new Date(r.at+25200000).toISOString().slice(0,10))).size};
}
