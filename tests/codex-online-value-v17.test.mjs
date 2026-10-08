import test from 'node:test';
import assert from 'node:assert/strict';
import {onlineActionV17,forwardReplayPassedV17} from '../scripts/codex-online-value-v17.mjs';
import {VALUE_ACTIONS,VALUE_CONFIGS} from '../scripts/codex-action-value-v15.mjs';
const at=10*86400000,o={id:'o',at,mint:'m',features:{return5:1,buy5:.7,buy20:.7,sigma:1,efficiency:.6,buyUsd:500,buyers:4}};
const labels=()=>Object.fromEntries(VALUE_ACTIONS.map(a=>[a.id,Array.from({length:24},(_,i)=>({id:String(i),mint:String(i),
  signalAt:at-2000-i,availableAt:at-1000,target:a.id==='FULL750_PEAK'?.2:-.1,features:o.features}))]));
test('online formula can learn only from already available labels',()=>{
  const past=labels(),decision=onlineActionV17(VALUE_CONFIGS[0],past,o);assert.equal(decision.action,'FULL750_PEAK');
  for(const a of VALUE_ACTIONS)past[a.id].push({id:'future',mint:'future',signalAt:at-1,availableAt:at+1,target:100,features:o.features});
  assert.deepEqual(decision,onlineActionV17(VALUE_CONFIGS[0],past,o));
});
test('old labels outside seven days cannot manufacture present evidence',()=>{
  const old=labels();for(const rs of Object.values(old))for(const r of rs)r.signalAt=at-8*86400000;
  assert.equal(onlineActionV17(VALUE_CONFIGS[0],old,o).action,'WAIT');
});
test('zero trades or one win cannot qualify as a good formula',()=>{
  assert.equal(forwardReplayPassedV17({P:{}},'P'),false);
});
test('qualification requires all execution stresses and portfolio reconciliation',()=>{
  const one=(pnl,blocked=false)=>({summary:{closed:100,days:7,unknown:0,conservativePnl:pnl,tailLoss10:0,eventBoundDrawdown:1},
    portfolio:{realizedPnl:pnl,blocked}});
  const results={P:{},AGY_NATIVE:{},AGY_REFERENCE:{}};
  for(const s of ['base','delay2s','feeStress']){results.P[s]=one(5);results.AGY_NATIVE[s]=one(1);results.AGY_REFERENCE[s]=one(2);}
  assert.equal(forwardReplayPassedV17(results,'P'),true);
  results.P.delay2s.portfolio.blocked=true;assert.equal(forwardReplayPassedV17(results,'P'),false);
});
