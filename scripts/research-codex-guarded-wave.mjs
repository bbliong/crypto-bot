// Usage: node --import tsx scripts/research-codex-guarded-wave.mjs
// Historical paper research only. Never imports the collector or any order-submission code.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { CODEX_GUARDED_WAVE_ID, CODEX_ENTRY_PROFILES, CODEX_EXIT_PROFILES } from '../src/codex-guarded-wave.ts';
import { prepareResearch, replayPortfolio, MISSING_EXECUTION_EVIDENCE } from './codex-guarded-wave-engine.mjs';
const root=resolve(import.meta.dirname,'..');
const bytes=readFileSync(resolve(root,'reports/guarded-wave-input-2026-10-02.json'));
const input=JSON.parse(bytes),dataHash=createHash('sha256').update(bytes).digest('hex');
const sourceHashes=Object.fromEntries(['src/codex-guarded-wave.ts','src/momentum-strategy.ts',
  'scripts/codex-guarded-wave-engine.mjs','scripts/guarded-wave-replay-core.mjs','scripts/research-codex-guarded-wave.mjs']
  .map(file=>[file,createHash('sha256').update(readFileSync(resolve(root,file))).digest('hex')]));
console.log('Preparing causal features from 3,540 captured detail visits; no orders will be submitted.');
const env=prepareResearch(input);
console.log(JSON.stringify({signals:Object.fromEntries(Object.entries(env.signals).map(([id,ss])=>[id,{signals:ss.length,mints:new Set(ss.map(s=>s.mint)).size}]))}));
const split1=input.start+12*3600000,split2=input.start+18*3600000;
const before=t=>new Set(input.sessions.filter(s=>s.start<t).map(s=>s.mint));
const parts={train:{start:input.start,end:split1,excludedMints:new Set()},
  validation:{start:split1,end:split2,excludedMints:before(split1)},
  test:{start:split2,end:input.end,excludedMints:before(split2)}};
const model={stakeUsd:10,costGate:true,latencyMs:1000};
// Cluster resampling by three-hour capture block. Few blocks -> descriptive uncertainty ONLY.
function clusteredLowerBound(rows){
  const blocks=Array.from({length:4},()=>[]);
  for(const r of rows)blocks[Math.min(3,Math.floor((r.signalAt-input.start)/10800000))].push(r);
  let seed=72319;
  const random=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/4294967296;};
  const samples=[];
  for(let i=0;i<1000;i++){
    const selected=[];for(let j=0;j<4;j++)selected.push(...blocks[Math.floor(random()*4)]);
    const pnl=selected.reduce((n,r)=>n+(r.pnlUsd??-10.052),0);samples.push(pnl);
  }
  samples.sort((a,b)=>a-b);return samples[25];
}
const training=[];
for(const entry of CODEX_ENTRY_PROFILES)for(const exit of CODEX_EXIT_PROFILES){
  const replay=replayPortfolio(env,env.signals[entry.id],exit,model,parts.train);
  training.push({id:`${entry.id}/${exit.id}`,entry,exit,...replay.summary,
    clusterPnlLowerBound:clusteredLowerBound(replay.rows),trainingRows:replay.rows});
}
// These minimum sample counts are pre-declared operational checks, not proof of significance.
const ranked=[...training].sort((a,b)=>b.clusterPnlLowerBound-a.clusterPnlLowerBound||b.conservativePnlUsd-a.conservativePnlUsd||b.closed-a.closed);
const qualifying=ranked.filter(r=>r.closed>=20&&r.unresolved===0&&r.conservativePnlUsd>0&&r.clusterPnlLowerBound>0);
const selected=qualifying[0]??null;
// If no formula passes training, still diagnose the training leader; NEVER relabel it validated.
const researchLeader=selected??ranked[0];
const evaluation={};
for(const[name,part]of Object.entries(parts))evaluation[name]=replayPortfolio(env,env.signals[researchLeader.entry.id],researchLeader.exit,model,part);
evaluation.validationDelay2s=replayPortfolio(env,env.signals[researchLeader.entry.id],researchLeader.exit,{...model,latencyMs:2000},parts.validation);
evaluation.testDelay2s=replayPortfolio(env,env.signals[researchLeader.entry.id],researchLeader.exit,{...model,latencyMs:2000},parts.test);
const fullDay={};
for(const[name,options]of Object.entries({
  configured_0_50:{stakeUsd:.5,costGate:true,latencyMs:1000},
  diagnostic_0_50_without_cost_gate:{stakeUsd:.5,costGate:false,latencyMs:1000},
  diagnostic_10_00:{...model},diagnostic_10_00_delay_2s:{...model,latencyMs:2000},
  diagnostic_10_00_extra_1pct_each_side:{...model,platformFee:.02},
}))fullDay[name]=replayPortfolio(env,env.signals[researchLeader.entry.id],researchLeader.exit,options);
const validated=!!selected&&evaluation.validation.summary.closed>=10&&evaluation.test.summary.closed>=10&&
  ['validation','test','validationDelay2s','testDelay2s'].every(k=>evaluation[k].summary.unresolved===0&&evaluation[k].summary.conservativePnlUsd>0);
const report={generatedAt:new Date().toISOString(),lane:CODEX_GUARDED_WAVE_ID,dateWib:'2026-10-02',dataHash,sourceHashes,
  rulesHash:createHash('sha256').update(JSON.stringify({entry:CODEX_ENTRY_PROFILES,exit:CODEX_EXIT_PROFILES})).digest('hex'),
  status:validated?'RETROSPECTIVE_DIAGNOSTIC_ONLY':'NO_VALIDATED_TRADING_FORMULA',
  liveAllowed:false,strictExecutionEvidenceAvailable:false,missingEvidence:MISSING_EXECUTION_EVIDENCE,
  configuredStakeUsd:.5,diagnosticStakeUsd:10,settingsChanged:false,
  methodology:{familySize:training.length,trainWib:'00:00–12:00',validationWib:'12:00–18:00',testWib:'18:00–24:00',
    selection:'Rank only the first 12 hours by three-hour cluster bootstrap lower PnL; require 20 closed, no unresolved, positive conservative PnL and lower bound.',
    independence:'The day was already inspected; this is retrospective chronological checking, NOT an untouched holdout. Four training clusters are too few for strong confidence.',
    purging:'Exclude mints seen in earlier partitions; no signals in final 90 seconds of each partition. One pending/open position, one successful entry per mint per day.',
    missing:'Missing execution/structural evidence is assumed ONLY for diagnostic price-model experiments; the strict execution gate rejects it.',
    fees:'1% per side + 0.000205 SOL per leg. Failed model transaction: 0.000105 SOL. DEX/creator fees, ATA rent and price impact unknown; extra-fee scenario included.',
    fills:'First fresh received tick after 1s or 2s delay, maximum extra wait 2s, buy cap 2%, sell cap 5%, maximum 3 sell attempts. No invented terminal mark.'},
  coverage:input.counts,signals:Object.fromEntries(Object.entries(env.signals).map(([id,ss])=>[id,{signals:ss.length,mints:new Set(ss.map(s=>s.mint)).size}])),
  selectedTrainingCandidate:selected?.id??null,researchLeader:{id:researchLeader.id,entry:researchLeader.entry,exit:researchLeader.exit},
  training:ranked,evaluation,fullDay,
  decision:'Keep live disabled and preserve the configured stake. No trading is the default until hard evidence, economics and forward validation pass.'};
mkdirSync(resolve(root,'reports'),{recursive:true});
writeFileSync(resolve(root,'reports/codex-guarded-wave-research-2026-10-02.json'),JSON.stringify(report,null,2)+'\n');
const small={...report,training:ranked.map(({trainingRows,...r})=>r),
  evaluation:Object.fromEntries(Object.entries(evaluation).map(([k,v])=>[k,v.summary])),
  fullDay:Object.fromEntries(Object.entries(fullDay).map(([k,v])=>[k,v.summary]))};
writeFileSync(resolve(root,'reports/codex-guarded-wave-summary-2026-10-02.json'),JSON.stringify(small,null,2)+'\n');
console.log(JSON.stringify({status:report.status,selectedTrainingCandidate:report.selectedTrainingCandidate,researchLeader:researchLeader.id,
  training:small.training.map(x=>({id:x.id,closed:x.closed,wins:x.wins,losses:x.losses,pnl:x.conservativePnlUsd,lower:x.clusterPnlLowerBound})),
  evaluation:small.evaluation,fullDay:small.fullDay}));
