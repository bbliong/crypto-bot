// Existing lane quotes are already net of whatever route output includes.
// Add ONLY the explicitly assumed network cost, never subtract platform fees twice.
import {readFileSync,writeFileSync} from 'node:fs';
const input=JSON.parse(readFileSync('reports/codex-all-history-audit.json'));
const networkSol=.000205,byLane={};
for(const r of input.records){
  const b=r.buyQuote,s=r.sellQuote;
  if(!r.paired||!(Number(b?.inAmount)>0)||!(Number(s?.outAmount)>0)||b.inDecimals!==9||s.outDecimals!==9)continue;
  const buySol=Number(b.inAmount)/1e9,sellSol=Number(s.outAmount)/1e9;
  const x=byLane[r.lane]??={pairs:0,routeWins:0,networkModelWins:0,networkModelLosses:0,
    routeReturnSum:0,networkReturnSum:0,networkPnlUsd:0,buyQuoteAfterExitSignal:0,stakes:{}};
  const gross=(sellSol/buySol-1)*100,net=((sellSol-networkSol)/(buySol+networkSol)-1)*100;
  x.pairs++;x.routeWins+=gross>0;x.networkModelWins+=net>0;x.networkModelLosses+=net<0;
  x.routeReturnSum+=gross;x.networkReturnSum+=net;
  x.networkPnlUsd+=(sellSol-buySol-2*networkSol)*(b.inUsd/buySol);
  if(b.at>r.exitAt)x.buyQuoteAfterExitSignal++;
  x.stakes[r.stake]=(x.stakes[r.stake]??0)+1;
}
for(const x of Object.values(byLane)){
  x.routeMeanPct=x.routeReturnSum/x.pairs;x.networkModelMeanPct=x.networkReturnSum/x.pairs;
  delete x.routeReturnSum;delete x.networkReturnSum;
}
const report={cutoff:input.cutoff,networkSolPerLeg:networkSol,byLane,
  caveats:['Quoted outputs, not confirmed fills. Network cost is a sensitivity assumption, not observed wallet fee.',
    'Venue/platform fees reflected in quoted outputs are not subtracted again. Rent and failed-transaction fees remain unknown.',
    'USD cost uses implied SOL price at buy. SOL return is primary; networkPnlUsd is a scenario sum, not a portfolio.',
    'Buy quote received after exit signal is an ordering warning: not proof a live position could execute those paper decisions.',
    'Lanes have different token/time exposure. Highest quote average is not an apples-to-apples validated best lane.']};
writeFileSync('reports/codex-lane-execution-audit.json',JSON.stringify(report,null,2));
console.log(JSON.stringify(report));
