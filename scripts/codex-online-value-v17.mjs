import {createHash} from 'node:crypto';
import {fitActionHeadsV15,chooseActionV15} from './codex-action-value-v15.mjs';
export function onlineActionV17(config,labels,opportunity){
  const windowed=Object.fromEntries(Object.entries(labels).map(([a,rs])=>[a,rs.filter(r=>r.signalAt>=opportunity.at-7*86400000)]));
  const heads=fitActionHeadsV15(config,windowed,opportunity.at);
  return {...chooseActionV15(heads,opportunity),modelHash:createHash('sha256').update(JSON.stringify(heads)).digest('hex'),
    historyN:Object.fromEntries(Object.entries(heads).map(([a,m])=>[a,m?.n??0]))};
}
export function forwardReplayPassedV17(results,policy){
  const p=results[policy];if(!p)return false;
  return ['base','delay2s','feeStress'].every(s=>{
    const r=p[s];if(!r?.summary||!r.portfolio)return false;const c=r.summary;
    return c.closed>=100&&c.days>=7&&c.unknown===0&&c.conservativePnl>0&&!r.portfolio.blocked&&r.portfolio.realizedPnl>0&&
      ['AGY_NATIVE','AGY_REFERENCE'].every(control=>{
        const b=results[control]?.[s];return !!b&&c.conservativePnl>b.summary.conservativePnl&&
          c.tailLoss10<=b.summary.tailLoss10&&c.eventBoundDrawdown<=b.summary.eventBoundDrawdown&&
          r.portfolio.realizedPnl>b.portfolio.realizedPnl;
      });
  });
}
