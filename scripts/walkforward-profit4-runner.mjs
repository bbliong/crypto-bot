// Small, regularized ranking model. Every fit uses only outcomes already observed.
import fs from 'node:fs';
import path from 'node:path';
const dir=process.argv[2]||'reports/profit4-patterns-2026-10-10';
const study=JSON.parse(fs.readFileSync(path.join(dir,'runner-study.json')));
const holders=JSON.parse(fs.readFileSync(path.join(dir,'runner-holdings-audit.json')));
const hmap=new Map(holders.rows.map(r=>[r.mint,r]));
const log=x=>x!==null&&x!==undefined&&x>=0?Math.log1p(x):null;
const specs=[
  ['price',r=>r.f.price*1e6],['momentum30',r=>r.f.momentum30],['drawdown',r=>r.f.drawdown],
  ['buy60_log',r=>log(r.f.meaningfulBuy60)],['sell60_log',r=>log(r.f.sellUsd60)],
  ['buyers60_log',r=>log(r.f.buyers60)],['topBuyerPct60',r=>r.f.topBuyerPct60],
  ['holderDelta30',r=>r.f.holderDelta30],
  ['rat_fresh10s',r=>r.f.ratPctAgeSeconds!==null&&r.f.ratPctAgeSeconds<=10?r.f.ratPct:null],
  ['dexBots_fresh10s_log',r=>r.f.dexBotCountAgeSeconds!==null&&r.f.dexBotCountAgeSeconds<=10?log(r.f.dexBotCount):null],
  ['knownRiskHoldPct_fresh30s',r=>{const a=(hmap.get(r.mint)?.holdings||[]).filter(h=>h.knownRiskBeforeEntry&&h.ageSeconds!==null&&h.ageSeconds<=30&&h.pct!==null);return a.length?Math.max(...a.map(h=>h.pct)):null;}],
  ['tokenAge',r=>r.f.ageSeconds],
];
const rows=study.decisions.filter(r=>r.seconds===60).sort((a,b)=>a.at-b.at).map(r=>({...r,
  x:specs.map(([,get])=>get(r)),label:['TARGET','DUMP','TIMEOUT'].includes(r.outcome.status)?+(r.outcome.status==='TARGET'):null,
  labelAt:r.at+r.outcome.seconds*1000}));
function transform(train){
  const means=specs.map((_,j)=>{const a=train.map(r=>r.x[j]).filter(x=>x!==null&&Number.isFinite(x));return a.length?a.reduce((n,x)=>n+x,0)/a.length:0;});
  const scales=specs.map((_,j)=>{const a=train.map(r=>r.x[j]).filter(x=>x!==null&&Number.isFinite(x));return Math.max(1e-6,Math.sqrt(a.reduce((n,x)=>n+(x-means[j])**2,0)/Math.max(1,a.length)));});
  return r=>[1,...r.x.map((x,j)=>x!==null&&Number.isFinite(x)?Math.max(-5,Math.min(5,(x-means[j])/scales[j])):0),...r.x.map(x=>+(x===null||!Number.isFinite(x)))];
}
const sigmoid=z=>1/(1+Math.exp(-Math.max(-30,Math.min(30,z))));
function fit(train){const tx=transform(train),xx=train.map(tx),n=train.length,w=Array(xx[0].length).fill(0),base=(train.reduce((n,r)=>n+r.label,0)+1)/(n+2);w[0]=Math.log(base/(1-base));
  for(let k=0;k<500;k++){const g=w.map((v,j)=>j===0?0:.2*v);for(let i=0;i<n;i++){const p=sigmoid(w.reduce((s,v,j)=>s+v*xx[i][j],0)),e=(p-train[i].label)/n;for(let j=0;j<w.length;j++)g[j]+=e*xx[i][j];}for(let j=0;j<w.length;j++)w[j]-=.05*g[j];}
  return {score:r=>sigmoid(w.reduce((s,v,j)=>s+v*tx(r)[j],0)),base,weights:w};}
const predictions=[];
for(const r of rows){const train=rows.filter(t=>t.at<r.at&&t.label!==null&&t.labelAt<r.at);if(train.length<20)continue;
  const model=fit(train);predictions.push({mint:r.mint,symbol:r.symbol,at:r.at,trainN:train.length,lastTrainingOutcomeAt:Math.max(...train.map(t=>t.labelAt)),
    score:model.score(r),baseline:model.base,label:r.label,outcome:r.outcome,execution1:r.execution1,execution2:r.execution2,features:Object.fromEntries(specs.map(([n],j)=>[n,r.x[j]]))});
}
const resolved=predictions.filter(r=>r.label!==null),pos=resolved.filter(r=>r.label===1),neg=resolved.filter(r=>r.label===0);
const auc=pos.length&&neg.length?pos.reduce((s,a)=>s+neg.reduce((n,b)=>n+(a.score>b.score?1:a.score===b.score?.5:0),0),0)/(pos.length*neg.length):null;
function summarize(a){const label=a.filter(r=>r.label!==null),closed=a.filter(r=>r.execution1.status==='CLOSED');return{n:a.length,labeled:label.length,targets:label.filter(r=>r.label===1).length,closed:closed.length,wins:closed.filter(r=>r.execution1.net>0).length,
  unresolved:a.length-closed.length,meanNet:closed.length?closed.reduce((s,r)=>s+r.execution1.net,0)/closed.length:null,worstNet:closed.length?Math.min(...closed.map(r=>r.execution1.net)):null};}
const result={method:'Walk-forward ridge logistic ranking at fixed60s, 12 predefined features + missing indicators, L2=0.2, minimum20 already-resolved past tokens. Training standardization from past only. Label available only when target/dump observed; no future rows in training. Identity of risk-wallet set was discovered retrospectively; feature additionally requires first known dump preceding decision. Thus still exploratory, not pristine prospective validation. Scores not calibrated probabilities.',
  features:specs.map(([n])=>n),cohort:rows.length,predictions:predictions.length,labeled:resolved.length,auc,
  brier:resolved.length?resolved.reduce((s,r)=>s+(r.score-r.label)**2,0)/resolved.length:null,
  baselineBrier:resolved.length?resolved.reduce((s,r)=>s+(r.baseline-r.label)**2,0)/resolved.length:null,
  selections:[{threshold:null,...summarize(predictions)},...[.4,.5,.6,.7].map(threshold=>({threshold,...summarize(predictions.filter(r=>r.score>=threshold))}))],rows:predictions};
fs.writeFileSync(path.join(dir,'runner-walkforward.json'),JSON.stringify(result,null,2));
console.log(JSON.stringify({...result,rows:undefined},null,2));
