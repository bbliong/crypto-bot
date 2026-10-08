// A small deterministic predictor. It receives only the history supplied by the caller.
export const EVIDENCE_FEATURES=Object.freeze({
  FLOW:['return5','buy5','buy20','sigma','efficiency','buyUsd','buyers'],
  SAFETY:['age','mc','top1','dev','sigma']
});
export const EVIDENCE_MODELS=['FLOW','SAFETY'].flatMap(features=>[1,2].map(depth=>({id:`EVIDENCE_${features}_D${depth}`,features,depth})));
const finite=x=>typeof x==='number'&&Number.isFinite(x);
function value(row,key){
  const x=row.features?.[key];if(!finite(x))return null;
  return ['age','mc','buyUsd','buyers'].includes(key)?Math.log1p(Math.max(0,x)):x;
}
const median=xs=>{const a=[...xs].sort((a,b)=>a-b);return a.length?a[Math.floor(a.length/2)]:0;};
const mean=xs=>xs.reduce((s,x)=>s+x,0)/xs.length;
function loss(rows){const m=mean(rows.map(r=>r.y));return rows.reduce((s,r)=>s+(r.y-m)**2,0);}
export function fitEvidenceV8(config,history){
  if(!EVIDENCE_FEATURES[config.features]||![1,2].includes(config.depth))throw new Error('Invalid frozen model');
  const keys=EVIDENCE_FEATURES[config.features],clean=history.filter(r=>finite(r.target));
  if(clean.length<24)return null;
  const medians=keys.map(k=>median(clean.map(r=>value(r,k)).filter(finite)));
  const rows=clean.map(r=>({x:keys.map((k,i)=>value(r,k)??medians[i]),y:r.target}));
  const global=mean(rows.map(r=>r.y));
  function build(rs,depth){
    const average=mean(rs.map(r=>r.y)),prediction=(average*rs.length+global*8)/(rs.length+8);
    const leaf={n:rs.length,mean:average,prediction};if(!depth||rs.length<16)return leaf;
    const base=loss(rs);let best=null;
    for(let feature=0;feature<keys.length;feature++){
      const sorted=[...rs].sort((a,b)=>a.x[feature]-b.x[feature]);
      for(let i=8;i<=sorted.length-8;i++){
        if(sorted[i-1].x[feature]===sorted[i].x[feature])continue;
        const threshold=(sorted[i-1].x[feature]+sorted[i].x[feature])/2;
        const left=sorted.slice(0,i),right=sorted.slice(i),gain=base-loss(left)-loss(right);
        if(gain>=.02&&(!best||gain>best.gain+1e-12))best={feature,threshold,left,right,gain};
      }
    }
    return best?{...leaf,feature:best.feature,threshold:best.threshold,gain:best.gain,
      left:build(best.left,depth-1),right:build(best.right,depth-1)}:leaf;
  }
  return {config:{...config},keys,medians,global,n:rows.length,tree:build(rows,config.depth),thresholdUsd:.04};
}
export function assessEvidenceV8(model,opportunity){
  if(!model)return {allowed:false,expectedPnl:null,reason:'INSUFFICIENT_HISTORY'};
  const x=model.keys.map((k,i)=>value(opportunity,k)??model.medians[i]);let node=model.tree;
  while(node.left)node=x[node.feature]<=node.threshold?node.left:node.right;
  return {allowed:node.prediction>model.thresholdUsd,expectedPnl:node.prediction,leafN:node.n,
    reason:node.prediction>model.thresholdUsd?'POSITIVE_EXPECTED_NET':'NO_POSITIVE_EXPECTED_NET'};
}
export function availableEvidenceV8(history,now){
  const seen=new Map();return history.filter(r=>r.availableAt<now).sort((a,b)=>a.signalAt-b.signalAt).filter(r=>{
    if(r.signalAt-(seen.get(r.mint)??-Infinity)<86400000)return false;seen.set(r.mint,r.signalAt);return true;
  });
}
export function prequentialEvidenceV8(config,opportunities,labels){
  return [...opportunities].sort((a,b)=>a.at-b.at).map(r=>{
    const history=availableEvidenceV8(labels,r.at),model=fitEvidenceV8(config,history);
    return {id:r.id,at:r.at,historyN:history.length,...assessEvidenceV8(model,r)};
  });
}
