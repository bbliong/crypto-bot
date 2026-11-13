import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { FollowerTickRecorder } from '../src/follower-tick-recorder.js';

function tick(n:number, time = 1800000) { return {schemaVersion:1 as const,sessionId:'s',connectionId:'c',requestId:'r',receiveSequence:n,itemIndex:0,receivedAt:time,channel:'token_activity' as const,mint:'mint',source:'gmgn_browser_ws' as const,raw:{a:'mint',e:'buy',h:`sig-${n}`}}; }

test('writes each raw item once, rotates by time, and persists manifest counts', async () => {
 const dir=await mkdtemp(join(tmpdir(),'follower-rec-'));
 try {
  const rec=new FollowerTickRecorder({outputDir:dir,sessionId:'s',flushIntervalMs:10});
  assert.equal(rec.record(tick(1,1800000)),true);
  assert.equal(rec.record(tick(2,3600000)),true);
  await rec.close();
  const chunks=(await readdir(join(dir,'s'))).filter(x=>x !== 'manifest.json').sort();
  assert.equal(chunks.length,2);
  const rows=[];
  for (const chunk of chunks) for (const line of (await readFile(join(dir,'s',chunk,'token-activity.jsonl'),'utf8')).trim().split('\n')) rows.push(JSON.parse(line));
  assert.deepEqual(rows.map(x=>x.raw.h),['sig-1','sig-2']);
  const manifest=JSON.parse(await readFile(join(dir,'s','manifest.json'),'utf8'));
  assert.equal(manifest.stats.written,2);
  assert.equal(manifest.status,'CLOSED');
  assert.deepEqual(rec.stats().queueRecords,0);
 } finally { await rm(dir,{recursive:true,force:true}); }
});

test('manifest reflects live counters before graceful shutdown', async () => {
 const dir=await mkdtemp(join(tmpdir(),'follower-rec-'));
 try {
  const rec=new FollowerTickRecorder({outputDir:dir,sessionId:'s',manifestIntervalMs:15});
  rec.record(tick(1));
  await new Promise(resolve=>setTimeout(resolve,80));
  const manifest=JSON.parse(await readFile(join(dir,'s','manifest.json'),'utf8'));
  assert.equal(manifest.status,'OPEN');
  assert.equal(manifest.stats.written,1);
  await rec.close();
 } finally {await rm(dir,{recursive:true,force:true});}
});

test('decision evidence writes separately from market ticks with correlation IDs',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'follower-rec-'));
 try {
  const rec=new FollowerTickRecorder({outputDir:dir,sessionId:'s'});
  rec.decision({kind:'scenario_action',actionId:'act-1',scenarioId:'S14',mint:'mint',side:'BUY',reason:'ENTRY',observedAt:1800000,positionId:null,originFrame:null});
  await rec.close();
  const chunk=(await readdir(join(dir,'s'))).find(x=>x!=='manifest.json')!;
  const row=JSON.parse((await readFile(join(dir,'s',chunk,'decisions.jsonl'),'utf8')).trim());
  assert.equal(row.actionId,'act-1');assert.equal(row.kind,'scenario_action');assert.equal(row.sessionId,'s');
  assert.equal(row.originFrame,null);
 } finally {await rm(dir,{recursive:true,force:true});}
});

test('decision writer drops unapproved fields and redacts unsafe labels',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'follower-rec-'));
 try {
  const rec=new FollowerTickRecorder({outputDir:dir,sessionId:'s'});
  rec.decision({kind:'order_response',actionId:'a',scenarioId:'S14',mint:'mint',side:'BUY',reason:'https://example.org/?api_key=SHOULD_NOT_APPEAR',observedAt:1800000,positionId:null,originFrame:null,secret:'SHOULD_NOT_APPEAR',ok:true});
  await rec.close();
  const chunk=(await readdir(join(dir,'s'))).find(x=>x!=='manifest.json')!;
  const text=await readFile(join(dir,'s',chunk,'decisions.jsonl'),'utf8');
  assert.equal(text.includes('SHOULD_NOT_APPEAR'),false);
  assert.equal(JSON.parse(text).ok,true);
 } finally {await rm(dir,{recursive:true,force:true});}
});

test('decision reason retains partial-exit operators without admitting credential text',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'follower-rec-'));
 try {
  const rec=new FollowerTickRecorder({outputDir:dir,sessionId:'s'});
  rec.decision({kind:'scenario_action',actionId:'a1',scenarioId:'S14',mint:'mint',side:'SELL',reason:'STAGE_1_TP_50% (Target sold >= 5% | bag > 0)',observedAt:1800000});
  rec.decision({kind:'scenario_action',actionId:'a2',scenarioId:'S14',mint:'mint',side:'SELL',reason:'api_key=SHOULD_NOT_APPEAR',observedAt:1800001});
  await rec.close();
  const chunk=(await readdir(join(dir,'s'))).find(x=>x!=='manifest.json')!;
  const text=await readFile(join(dir,'s',chunk,'decisions.jsonl'),'utf8');
  const rows=text.trim().split('\n').map(line=>JSON.parse(line));
  assert.equal(rows[0].reason,'STAGE_1_TP_50% (Target sold >= 5% | bag > 0)');
  assert.equal(rows[1].reason,'[REDACTED]');
  assert.equal(text.includes('SHOULD_NOT_APPEAR'),false);
 } finally {await rm(dir,{recursive:true,force:true});}
});

test('quote evidence retains real AMM amounts and units but strips quote payload secrets',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'follower-rec-'));
 try {
  const rec=new FollowerTickRecorder({outputDir:dir,sessionId:'s'});
  rec.decision({kind:'amm_quote_result',actionId:'a1',scenarioId:'S14',mint:'mint',side:'SELL',reason:'EXIT',observedAt:1800000,
   ok:true,inAmountBaseUnits:'2500000',outAmountBaseUnits:'123456789',inDecimals:6,outDecimals:9,
   amountOutUsd:12.34,exchange:'Raydium',rawQuote:{cookie:'SHOULD_NOT_APPEAR'}});
  await rec.close();
  const chunk=(await readdir(join(dir,'s'))).find(x=>x!=='manifest.json')!;
  const text=await readFile(join(dir,'s',chunk,'decisions.jsonl'),'utf8');
  const row=JSON.parse(text);
  assert.equal(text.includes('SHOULD_NOT_APPEAR'),false);
  assert.equal(row.outAmountBaseUnits,'123456789');
  assert.equal(row.outDecimals,9);
  assert.equal(row.amountOutUsd,12.34);
 } finally {await rm(dir,{recursive:true,force:true});}
});

test('subscription coverage gap forces manifest INCOMPLETE without adding market ticks',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'follower-rec-'));
 try {
  const rec=new FollowerTickRecorder({outputDir:dir,sessionId:'s'});
  rec.coverageGap('socket_replaced',{activeSubscriptionCount:2});
  await rec.close();
  const manifest=JSON.parse(await readFile(join(dir,'s','manifest.json'),'utf8'));
  assert.equal(manifest.stats.coverageGaps,1);
  assert.equal(manifest.status,'INCOMPLETE');
  const chunk=(await readdir(join(dir,'s'))).find(x=>x!=='manifest.json')!;
  const events=(await readFile(join(dir,'s',chunk,'lifecycle.jsonl'),'utf8')).trim().split('\n').map(line=>JSON.parse(line));
  assert.equal(events[0].event,'subscription_coverage_unverified');
 } finally {await rm(dir,{recursive:true,force:true});}
});

test('close times out on stalled IO and marks session incomplete', async () => {
 const dir=await mkdtemp(join(tmpdir(),'follower-rec-'));
 let release!:()=>void;
 const stalled=new Promise<void>(resolve=>{release=resolve;});
 try {
  const rec=new FollowerTickRecorder({outputDir:dir,sessionId:'s',closeTimeoutMs:30,writeLine:async()=>{await stalled;}});
  rec.record(tick(1));
  await rec.close();
  const manifest=JSON.parse(await readFile(join(dir,'s','manifest.json'),'utf8'));
  assert.equal(manifest.status,'INCOMPLETE');
  assert.equal(manifest.stats.writeUncertain,1);
 } finally {release();await rm(dir,{recursive:true,force:true});}
});

test('bounded queue drops newest and keeps trading path nonthrowing on write failures', async () => {
 const dir=await mkdtemp(join(tmpdir(),'follower-rec-'));
 let release!:()=>void;
 const block = new Promise<void>(resolve=>{ release=resolve; });
 try {
  const rec=new FollowerTickRecorder({outputDir:dir,sessionId:'s',maxQueueRecords:1,maxQueueBytes:10000,writeLine:async()=>{await block;throw new Error('disk unavailable');}});
  assert.equal(rec.record(tick(1)),true);
  assert.equal(rec.record(tick(2)),false);
  release();
  await rec.close();
  assert.equal(rec.stats().dropped,1);
  assert.equal(rec.stats().writeUncertain,1);
  assert.equal(rec.stats().written,0);
  assert.equal(rec.stats().received,2);
  const manifest=JSON.parse(await readFile(join(dir,'s','manifest.json'),'utf8'));
  assert.equal(manifest.status,'INCOMPLETE');
 } finally {release();await rm(dir,{recursive:true,force:true});}
});
