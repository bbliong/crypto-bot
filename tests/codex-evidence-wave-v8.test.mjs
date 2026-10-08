import test from 'node:test';
import assert from 'node:assert/strict';
import {fitEvidenceV8,assessEvidenceV8,availableEvidenceV8,prequentialEvidenceV8} from '../scripts/codex-evidence-wave-v8.mjs';
const config={id:'EVIDENCE_SAFETY_D1',features:'SAFETY',depth:1};
const history=Array.from({length:32},(_,i)=>({id:String(i),mint:String(i),signalAt:i*1000,availableAt:i*1000+500,
  target:i<16?-1:1,features:{age:i<16?100:1000,mc:20000,top1:3,dev:1,sigma:2}}));
test('small models are deterministic and do not fit when history is insufficient',()=>{
  assert.equal(fitEvidenceV8(config,history.slice(0,23)),null);
  assert.deepEqual(fitEvidenceV8(config,history),fitEvidenceV8(config,history));
});
test('leaf outcomes shrink toward the global mean and can discriminate a simple signal',()=>{
  const model=fitEvidenceV8(config,history);
  assert.equal(assessEvidenceV8(model,{features:{age:100,mc:20000,top1:3,dev:1,sigma:2}}).allowed,false);
  const good=assessEvidenceV8(model,{features:{age:1000,mc:20000,top1:3,dev:1,sigma:2}});
  assert.equal(good.allowed,true);assert.ok(good.expectedPnl<1);
});
test('future and exact-now outcomes cannot enter a decision history',()=>{
  assert.equal(availableEvidenceV8(history,500).length,0);
  assert.equal(availableEvidenceV8(history,501).length,1);
  assert.equal(availableEvidenceV8(history,1000).length,1);
});
test('prequential predictions are invariant to changed future labels',()=>{
  const rs=[{id:'a',at:25000,features:history[20].features}];
  const modified=history.map(r=>r.availableAt>=25000?{...r,target:100}:r);
  assert.deepEqual(prequentialEvidenceV8(config,rs,history),prequentialEvidenceV8(config,rs,modified));
});
test('model imputes missing features from the fitted history, not current values',()=>{
  const model=fitEvidenceV8(config,history);assert.ok(Number.isFinite(assessEvidenceV8(model,{features:{}}).expectedPnl));
  assert.deepEqual(model.medians,fitEvidenceV8(config,[...history].reverse()).medians);
});
test('a mint does not supply repeated labels within a 24-hour window',()=>{
  const a=[{mint:'m',signalAt:0,availableAt:100,target:1},{mint:'m',signalAt:200,availableAt:300,target:2}];
  assert.equal(availableEvidenceV8(a,1000).length,1);
});
