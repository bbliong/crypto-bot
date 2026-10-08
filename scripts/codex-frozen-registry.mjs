import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
import {replayAdaptiveTrade} from './codex-adaptive-engine.mjs';
import {assessEvidenceV8} from './codex-evidence-wave-v8.mjs';
import {evaluateRecheckV9} from './codex-prebuy-recheck-v9.mjs';
import {evaluatePeakV10} from './codex-peak-recheck-v10.mjs';
import {evaluateProbationV11} from './codex-probation-wave-v11.mjs';
export const FROZEN_POLICIES=['AGY_NATIVE','AGY_REFERENCE','CODEX_EVIDENCE_V8','CODEX_RECHECK_V9','CODEX_PEAK_V10','CODEX_PROBATION_V11'];
export const registryHash=p=>createHash('sha256').update(readFileSync(p)).digest('hex');
export function frozenRegistry(){
  const paths={v8:'reports/codex-evidence-v8-selection.json',v9:'reports/codex-prebuy-v9-selection.json',
    v10:'reports/codex-peak-v10-selection.json',v11:'reports/codex-probation-v11-selection.json'};
  const selections=Object.fromEntries(Object.entries(paths).map(([k,p])=>[k,JSON.parse(readFileSync(p))]));
  const hashes={};for(const s of Object.values(selections))Object.assign(hashes,s.hashes);
  for(const p of [...Object.values(paths),'scripts/codex-frozen-registry.mjs'])hashes[p]=registryHash(p);
  const registry={selections,hashes};verifyRegistry(registry);return registry;
}
export function verifyRegistry(registry){for(const[p,h]of Object.entries(registry.hashes))assert.equal(registryHash(p),h,`Frozen registry changed ${p}`);}
export function evaluateFrozenPolicy(policy,signal,prepared,options,registry){
  if(policy.startsWith('AGY_'))return replayAdaptiveTrade({...signal,lane:policy},prepared,options);
  const s=registry.selections;
  if(policy==='CODEX_EVIDENCE_V8'){
    const decision=assessEvidenceV8(s.v8.model,signal);
    return decision.allowed?{...replayAdaptiveTrade({...signal,lane:'AGY_NATIVE'},prepared,options),evidence:decision}:
      {...options,status:'SKIP',stakeUsd:0,pnl:0,ret:null,at:signal.at,reason:decision.reason,evidence:decision};
  }
  if(policy==='CODEX_RECHECK_V9')return evaluateRecheckV9(signal,prepared,s.v9.selected,options);
  if(policy==='CODEX_PEAK_V10')return evaluatePeakV10(signal,prepared,s.v10.selected,options);
  if(policy==='CODEX_PROBATION_V11')return evaluateProbationV11(signal,prepared,s.v11.selected,options);
  throw new Error(`Unregistered policy ${policy}`);
}
