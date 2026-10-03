import test from 'node:test';
import assert from 'node:assert/strict';
import { CODEX_ENTRY_PROFILES, CODEX_EXIT_PROFILES, assessCodexSetup, confirmCodexSetup,
  assessCodexExecution, codexExitState, assessCodexExit, type Features, type ExecutionEvidence,
  type ExitObservation } from '../src/codex-guarded-wave.js';

const setup = (): Features => ({ at:30_000,price:1,ready:true,historyMs:25_000,socketAgeMs:0,tokenAgeSec:100,
  holderAgeMs:1000,devAgeMs:1000,countAgeMs:1000,holderValid:true,devValid:true,count:200,mc:30_000,
  top1:3,top5:12,dev:1,return5:3,slope5:2,drawdown5:1,trades5:8,buyers5:6,buyUsd5:500,
  topBuyerShare:.25,buyShare5:.8,buyShare20:.75,devSell30:0,majorSell:false,candleValid:true,solUsd:120,solAgeMs:1000 });
const execution = (): ExecutionEvidence => ({ now:30_000,stakeUsd:.5,liquidEquityUsd:100,unresolvedPosition:false,
  mintVerified:true,poolVerified:true,sellSimulationOk:true,quoteReceivedAt:29_900,quoteSlot:100,quoteRttMs:250,
  quantityMatches:true,quoteImpactPct:.5,quoteSocketDeviationPct:.5,buyAllInSol:1,immediateSellNetSol:.98,minimumSellNetSol:.95 });
const observation = (extra: Partial<ExitObservation> = {}): ExitObservation => ({ at:1000,net:2,socket:4,stale:false,
  structuralDanger:false,collapse1s:null,buyShare5:.8,sellUsd5:0,sellers5:0,slope5:1,tickId:'a',newTick:true,...extra });

test('Codex observable setup accepts valid evidence, but is not an execution permission',()=>{
  assert.equal(assessCodexSetup(setup()).allowed,true);
  assert.equal(assessCodexExecution({...execution(),mintVerified:null}).allowed,false);
});
test('unknown holder/dev/count and non-finite data never become safe zeros',()=>{
  for(const field of ['top1','top5','dev','count','mc','buyShare20'] as const)
    assert.equal(assessCodexSetup({...setup(),[field]:null}).allowed,false,field);
  assert.equal(assessCodexSetup({...setup(),top1:NaN}).allowed,false);
  assert.equal(assessCodexSetup({...setup(),devValid:false}).allowed,false);
});
test('freshness relaxation is explicit research profile, not a change to the baseline',()=>{
  const f={...setup(),devAgeMs:20_000};
  assert.equal(assessCodexSetup(f,CODEX_ENTRY_PROFILES[0]).allowed,false);
  assert.equal(assessCodexSetup(f,CODEX_ENTRY_PROFILES[1]).allowed,true);
  assert.equal(assessCodexSetup({...f,devAgeMs:-1},CODEX_ENTRY_PROFILES[1]).allowed,false);
});
test('entry blocks absent history, dev sell and concentrated buyers',()=>{
  for(const patch of [{historyMs:19_999},{devSell30:25},{majorSell:true},{topBuyerShare:.7},{socketAgeMs:751}])
    assert.equal(assessCodexSetup({...setup(),...patch}).allowed,false);
});
test('confirmation needs different received ticks at least 150 ms apart',()=>{
  const arm=confirmCodexSetup(null,true,1000,1,'a').arm;
  assert.equal(confirmCodexSetup(arm,true,1100,1,'b').confirmed,false);
  assert.equal(confirmCodexSetup(arm,true,1200,1,'a').confirmed,false);
  assert.equal(confirmCodexSetup(arm,true,1200,1,'b').confirmed,true);
});
test('invalidated or moved setups do not remain armed',()=>{
  const arm=confirmCodexSetup(null,true,1000,1,'a').arm;
  assert.equal(confirmCodexSetup(arm,false,1200,1,'b').arm,null);
  assert.equal(confirmCodexSetup(arm,true,1200,1.03,'b').confirmed,false);
  assert.equal(confirmCodexSetup(arm,true,1600,1,'b').confirmed,false);
});
test('execution requires real structural, quote and minimum-output evidence',()=>{
  assert.equal(assessCodexExecution(execution()).allowed,true);
  for(const patch of [{poolVerified:null},{sellSimulationOk:null},{quoteSlot:null},{minimumSellNetSol:null},
    {quantityMatches:false},{quoteReceivedAt:31_000},{quoteRttMs:1500},{quoteImpactPct:2}])
    assert.equal(assessCodexExecution({...execution(),...patch}).allowed,false);
});
test('all-in economics and capital constrain execution without changing stake',()=>{
  for(const patch of [{immediateSellNetSol:.885},{minimumSellNetSol:.93},{liquidEquityUsd:20},{unresolvedPosition:true}])
    assert.equal(assessCodexExecution({...execution(),...patch}).allowed,false);
});
test('hard risk is an exit request, not a fictional -6 percent fill',()=>{
  const state=codexExitState(0);
  assert.equal(assessCodexExit(state,observation({net:-35,socket:-30})),'HARD_RISK');
  assert.equal('sellPrice' in state,false);
});
test('watchdog acts without a new trade',()=>{
  assert.equal(assessCodexExit(codexExitState(0),observation({stale:true,newTick:false})),'DATA_STALE');
  assert.equal(assessCodexExit(codexExitState(0),observation({structuralDanger:true,newTick:false})),'STRUCTURAL_DANGER');
});
test('flow exit requires two distinct observations, not duplicate watchdog calls',()=>{
  const s=codexExitState(0),o=observation({buyShare5:.2,sellUsd5:200,sellers5:3,slope5:-1});
  assert.equal(assessCodexExit(s,o),null);
  assert.equal(assessCodexExit(s,{...o,at:1100,newTick:false}),null);
  assert.equal(assessCodexExit(s,{...o,at:1200,tickId:'b'}),'FLOW_BROKEN');
});
test('profit floor cannot loosen when peak crosses a runner threshold',()=>{
  const s=codexExitState(0);
  assessCodexExit(s,observation({net:19,socket:21}));
  const floor=s.floorNet!;
  assessCodexExit(s,observation({at:1200,net:22,socket:24}),CODEX_EXIT_PROFILES[2]);
  assert.ok(s.floorNet!>=floor);
  assert.equal(assessCodexExit(s,observation({at:1500,net:10,socket:12})),'PROFIT_FLOOR');
});
test('time limit issues an exit but never closes an unfilled position',()=>{
  const s=codexExitState(0);
  assert.equal(assessCodexExit(s,observation({at:90_000,net:4,socket:6})),'TIME_LIMIT');
  assert.equal('closed' in s,false);
});
