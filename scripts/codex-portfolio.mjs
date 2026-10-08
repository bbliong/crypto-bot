// A shadow position must remain occupied while its outcome is unresolved.
export function simulateOnePosition(rows,stakeUsd){
  let busy=-Infinity,blocked=false,realizedPnl=0,lossStreak=0,pause=-Infinity,currentDay=null,daily=0;
  const selected=[],skipped={pending:0,unresolved:0,lossLimit:0,cooldown:0};
  for(const r of [...rows].sort((a,b)=>a.signalAt-b.signalAt)){
    if(blocked){skipped.unresolved++;continue;}
    if(r.signalAt<busy){skipped.pending++;continue;}
    if(r.day!==currentDay){currentDay=r.day;daily=0;lossStreak=0;}
    if(daily<=-2*stakeUsd){skipped.lossLimit++;continue;}
    if(r.signalAt<pause){skipped.cooldown++;continue;}
    selected.push(r);busy=r.at??Infinity;
    if(r.pnl===null){blocked=true;continue;}
    realizedPnl+=r.pnl;daily+=r.pnl;
    if(r.status==='CLOSED')lossStreak=r.pnl<0?lossStreak+1:0;
    if(lossStreak>=3){pause=busy+900000;lossStreak=0;}
  }
  return {attempts:selected.length,closed:selected.filter(r=>r.status==='CLOSED').length,
    wins:selected.filter(r=>r.status==='CLOSED'&&r.pnl>0).length,
    losses:selected.filter(r=>r.status==='CLOSED'&&r.pnl<0).length,
    buyFailed:selected.filter(r=>r.status==='BUY_FAILED').length,realizedPnl,blocked,
    firstUnresolved:selected.find(r=>r.pnl===null)?.id??null,skipped,
    selectedIds:selected.map(r=>r.id)};
}
