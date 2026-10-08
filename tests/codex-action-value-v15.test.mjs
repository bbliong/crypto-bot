import test from 'node:test';
import assert from 'node:assert/strict';
import {fitActionHeadsV15,chooseActionV15,prequentialActionsV15,actionLabelsV15,VALUE_ACTIONS,VALUE_CONFIGS} from '../scripts/codex-action-value-v15.mjs';
const config=VALUE_CONFIGS[0],o={id:'current',at:100,mint:'m',features:{return5:1,buy5:.7,buy20:.7,sigma:1,efficiency:.6,buyUsd:500,buyers:4}};
const history=(target,availableAt=1)=>Array.from({length:24},(_,i)=>({id:String(i),mint:String(i),signalAt:i,availableAt,target,features:o.features}));
const labels=()=>Object.fromEntries(VALUE_ACTIONS.map(a=>[a.id,history(a.id==='FULL1500_PEAK'?.2:-.2)]));
test('router waits when no past action has positive value',()=>{
  assert.equal(chooseActionV15(fitActionHeadsV15(config,{},100),o).action,'WAIT');
  const l=Object.fromEntries(VALUE_ACTIONS.map(a=>[a.id,history(-.1)]));
  assert.equal(chooseActionV15(fitActionHeadsV15(config,l,100),o).action,'WAIT');
});
test('router can choose a delayed action from past resolved net outcomes',()=>{
  assert.equal(chooseActionV15(fitActionHeadsV15(config,labels(),100),o).action,'FULL1500_PEAK');
});
test('simultaneous and later outcome labels cannot influence current routing',()=>{
  const late=Object.fromEntries(VALUE_ACTIONS.map(a=>[a.id,history(100,100)]));
  assert.equal(chooseActionV15(fitActionHeadsV15(config,late,100),o).action,'WAIT');
  const a=prequentialActionsV15(config,labels(),[o]);
  const b=labels();for(const k of Object.keys(b))b[k].push(...history(100,200).map(r=>({...r,mint:`future${r.mint}`})));
  assert.deepEqual(a,prequentialActionsV15(config,b,[o]));
});
test('unknown label becomes a risk proxy only at capture end',()=>{
  const row={id:'r',mint:'m',opportunityAt:10,at:null,captureEnd:90,pnl:null,bound:-5.1,status:'SELL_UNKNOWN'};
  const actions=Object.fromEntries(VALUE_ACTIONS.map(a=>[a.id,{base:{rows:[row]}}]));
  const result=actionLabelsV15(actions,new Map([['r',{at:10,features:{age:60}}]]));
  assert.equal(result.DIRECT_PEAK[0].availableAt,90);assert.equal(result.DIRECT_PEAK[0].target,-5.1);
});
test('recheck skip is not known at the original opportunity',()=>{
  const row={id:'r',mint:'m',opportunityAt:10,at:760,captureEnd:90000,pnl:0,bound:0,status:'SKIP'};
  const actions=Object.fromEntries(VALUE_ACTIONS.map(a=>[a.id,{base:{rows:[row]}}]));
  assert.equal(actionLabelsV15(actions,new Map([['r',o]])).FULL750_PEAK[0].availableAt,760);
});
