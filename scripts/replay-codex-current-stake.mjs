// Sensitivity only: freeze the already-selected formula and signals; change no live settings.
import {readFileSync,writeFileSync} from 'node:fs';
import assert from 'node:assert/strict';
import {historySources,loadHistorySource} from './codex-history-source.mjs';
import {prepareFlowWaveSession,replayFlowWave} from './codex-flow-wave-engine.mjs';
import {simulateOnePosition} from './codex-portfolio.mjs';
const output='reports/codex-v2-current-stake.json';
function save(report){
  for(const e of Object.values(report.evaluation))e.portfolio=simulateOnePosition(e.rows,report.stakeUsd);
  writeFileSync(output,JSON.stringify(report,null,2));
  const small={...report,evaluation:Object.fromEntries(Object.entries(report.evaluation).map(([k,v])=>[k,{summary:v.summary,portfolio:v.portfolio}]))};
  writeFileSync('reports/codex-v2-current-stake-summary.json',JSON.stringify(small,null,2));
  console.log(JSON.stringify(small));
}
if(process.argv.includes('--summarize')){save(JSON.parse(readFileSync(output)));process.exit(0);}
const config=JSON.parse(readFileSync('config/autobuy-settings.json'));
const stakeUsd=config.stakeUsd;
assert.ok(Number.isFinite(stakeUsd)&&stakeUsd>0);
const chosen=JSON.parse(readFileSync('reports/codex-v2-configured-selection.json')).results['0.5'];
const history=JSON.parse(readFileSync('reports/codex-v2-configured-history.json'));
const ids=new Set(Object.values(chosen.evaluation).flatMap(e=>e.rows.map(r=>r.id)));
const groups=new Map();for(const r of history.records)if(ids.has(r.id)){
  if(!groups.has(r.source))groups.set(r.source,[]);groups.get(r.source).push(r);
}
const outcomes=new Map();let progress=0;
for(const source of historySources().filter(s=>groups.has(s.id))){
  const signals=groups.get(source.id),data=await loadHistorySource(source,{onlyMints:new Set(signals.map(r=>r.mint))});
  for(const s of data.sessions){const ss=signals.filter(r=>r.sessionId===s.id);if(!ss.length)continue;
    const prepared=prepareFlowWaveSession(data,s,[]);
    for(const r of ss){
      const options={stakeUsd,buyPriceCap:1/(1-config.buySlippagePercent/100)-1,sellOutputCap:config.sellSlippagePercent/100};
      outcomes.set(r.id,{normal:replayFlowWave(r,prepared,chosen.selected.exit,{...options,delayMs:1000}),
        delay:replayFlowWave(r,prepared,chosen.selected.exit,{...options,delayMs:2000}),
        fee:replayFlowWave(r,prepared,chosen.selected.exit,{...options,delayMs:1000,feeSide:.02})});
    }
  }
  console.log(JSON.stringify({progress:++progress,sources:groups.size}));
}
const summary=rows=>{
  const closed=rows.filter(r=>r.status==='CLOSED'),known=rows.reduce((s,r)=>s+(r.pnl??0),0);
  return {signals:rows.length,closed:closed.length,wins:closed.filter(r=>r.ret>0).length,losses:closed.filter(r=>r.ret<0).length,
    buyFailed:rows.filter(r=>r.status==='BUY_FAILED').length,unknown:rows.filter(r=>r.status.includes('UNKNOWN')).length,
    knownPnl:known,conservativePnl:rows.reduce((s,r)=>s+r.conservativePnl,0),
    closedMeanPct:closed.length?closed.reduce((s,r)=>s+r.ret,0)/closed.length:null};
};
const evaluation={};
for(const[k,v]of Object.entries(chosen.evaluation)){
  const mode=k.includes('Delay')?'delay':k.includes('Fee')?'fee':'normal';
  const rows=v.rows.map(r=>{
    const o=outcomes.get(r.id)?.[mode];assert.ok(o,r.id);
    const conservativePnl=o.pnl??-(stakeUsd+.000205*r.solUsd+(o.failedSell??0)*.000105*r.solUsd);
    return {...r,...o,conservativePnl};
  });
  evaluation[k]={summary:summary(rows),rows};
}
const report={cutoff:history.cutoff,stakeUsd,configSnapshot:{enabled:config.enabled,activeLane:config.activeLane,
  buySlippagePercent:config.buySlippagePercent,sellSlippagePercent:config.sellSlippagePercent},
  selected:chosen.selected.id,selection:'Frozen choice from earlier $0.50 training; not reselected at the new stake.',
  liveAllowed:false,evaluation,caveats:['Socket-based model, not quote/on-chain fills; identical entry signals as the earlier experiment.',
    'Independent event outcomes, not simultaneous executable portfolio PnL. Unknown exposure must block subsequent live entries.',
    'Network/venue fee assumptions unchanged. Current configuration is read, never modified.']};
save(report);
