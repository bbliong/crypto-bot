// Post-hoc failure diagnosis ONLY. Future markouts below are never fed to a strategy or selector.
import {readFileSync,writeFileSync} from 'node:fs';
import {historySources,loadHistorySource} from './codex-history-source.mjs';
import {prepareAdaptiveSession} from './codex-adaptive-engine.mjs';
import {asOf} from './guarded-wave-replay-core.mjs';
import {outcomeRows} from './codex-same-entry-analysis.mjs';
const overnight=process.argv.includes('--overnight');
const input=JSON.parse(readFileSync(`reports/codex-same-entry${overnight?'-overnight':''}-replay.json`));
const comparison=overnight?null:JSON.parse(readFileSync('reports/codex-same-entry-comparison.json'));
const policy=overnight?input.selected:comparison.selected;
const cohort=overnight?input.records.filter(r=>input.cohortIds.includes(r.id)):null;
const rows=overnight?outcomeRows(cohort,policy,1000,.01,input.cutoff):comparison.results.all.base[policy].rows;
const baseRows=overnight?outcomeRows(cohort,'AGY_NATIVE',1000,.01,input.cutoff):comparison.results.all.base.AGY_NATIVE.rows;
const byBase=new Map(baseRows.map(r=>[r.id,r]));
const known=rows.filter(r=>r.pnl!==null&&byBase.get(r.id).pnl!==null)
  .sort((a,b)=>(a.pnl-byBase.get(a.id).pnl)-(b.pnl-byBase.get(b.id).pnl));
const worst=[...byBase.values()].filter(r=>r.ret!==null).sort((a,b)=>a.ret-b.ret)[0];
const ids=new Set([...known.slice(0,3),...known.slice(-3),...rows.filter(r=>r.pnl===null&&byBase.get(r.id).pnl!==null),worst].filter(Boolean).map(r=>r.id));
const chosen=input.records.filter(r=>ids.has(r.id)),sources=historySources(),output=[];
for(const source of sources.filter(s=>chosen.some(r=>r.source===s.id))){
  const ss=chosen.filter(r=>r.source===source.id),data=await loadHistorySource(source,{onlyMints:new Set(ss.map(r=>r.mint)),cutoff:input.cutoff});
  for(const signal of ss){
    const s=data.sessions.find(s=>s.id===signal.sessionId);s.end=Math.min(s.end,signal.captureEnd);
    const p=prepareAdaptiveSession(data,s,[]),candidate=rows.find(r=>r.id===signal.id),baseline=byBase.get(signal.id);
    const f=asOf(p.frames,candidate.exitSignalAt??s.end,'at');
    const after=p.ticks.filter(t=>candidate.at!==null&&t.observedAt>candidate.at);
    const peak=after.length?after.reduce((a,b)=>a.priceUsd>b.priceUsd?a:b):null;
    output.push({id:signal.id,symbol:signal.symbol,source:signal.source,signalAt:signal.at,
      candidate:{status:candidate.status,pnl:candidate.pnl,reason:candidate.reason,exitSignalAt:candidate.exitSignalAt,fillAt:candidate.at},
      baseline:{status:baseline.status,pnl:baseline.pnl,reason:baseline.reason,exitSignalAt:baseline.exitSignalAt,fillAt:baseline.at},
      evidence:f?{at:f.at,return2:f.return2,buy2:f.buy2,buy5:f.buy5,buy20:f.buy20,devSell30:f.devSell30,majorSell:f.majorSell,
        collapse1s:f.collapse1s,priceAgeMs:f.at-f.priceAt,sigma1:f.sigma1,drawdown5:f.drawdown5}:null,
      descriptiveFutureOnly:{ticksAfterCandidateExit:after.length,maxPriceAfterExit:peak?.priceUsd??null,peakAt:peak?.observedAt??null,
        percentAboveCandidateFill:peak&&candidate.sellPrice?(peak.priceUsd/candidate.sellPrice-1)*100:null}});
  }
}
writeFileSync(`reports/codex-same-entry${overnight?'-overnight':''}-case-audit.json`,JSON.stringify({policy,postHoc:true,
  warning:'Selected best/worst divergences; not representative frequency estimates. Future observations are diagnostic, not executable oracle exits.',cases:output},null,2));
console.log(JSON.stringify(output.map(x=>({symbol:x.symbol,reason:x.candidate.reason,pnl:x.candidate.pnl,agyPnl:x.baseline.pnl,
  collapse:x.evidence?.collapse1s,buy5:x.evidence?.buy5,devSell:x.evidence?.devSell30,major:x.evidence?.majorSell}))));
