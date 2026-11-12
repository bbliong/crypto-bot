import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
test('real HTTP config API persists S14 family safely in isolated data dir',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'s14-api-'));mkdirSync(join(dir,'data'));
 writeFileSync(join(dir,'data/follower-autobuy-settings.json'),JSON.stringify({enabled:false,autobuyScenario:'DRY_RUN',autoSell:false}));
 const child=spawn(process.execPath,[fileURLToPath(new URL('../scripts/serve-wallet-follower-dashboard.mjs',import.meta.url))],{cwd:dir,env:{...process.env,FOLLOWER_DASHBOARD_PORT:'0'},stdio:['ignore','pipe','pipe']});
 try{
  const port=await new Promise((resolve,reject)=>{
   const timer=setTimeout(()=>reject(new Error('test server startup timeout')),5000);
   child.once('exit',code=>{clearTimeout(timer);reject(new Error('test server exit '+code));});
   child.stdout.on('data',b=>{const m=String(b).match(/Berjalan di port (\d+)/);if(m){clearTimeout(timer);resolve(Number(m[1]));}});
   child.stderr.on('data',b=>process.stderr.write(b));
  });
  const post=async body=>{const r=await fetch(`http://127.0.0.1:${port}/api/autobuy/config`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});return {status:r.status,body:await r.json()};};
  for(const sc of ['S14','S14_ALPHA','S15','S14_BETA']){
   assert.equal((await post({autobuyScenario:sc,enabled:false})).status,200);
   const saved=JSON.parse(readFileSync(join(dir,'data/follower-autobuy-settings.json')));
   assert.equal(saved.autobuyScenario,sc);assert.equal(saved.enabled,false);assert.equal(saved.autoSell,false);
  }
  await post({stakeUsdS14:2,stakeUsdS14Alpha:3,stakeUsdS15:4});
  let saved=JSON.parse(readFileSync(join(dir,'data/follower-autobuy-settings.json')));
  assert.equal(saved.stakeUsdS14,2);assert.equal(saved.stakeUsdS14Alpha,3);assert.equal(saved.stakeUsdS14Beta,4);
  assert.equal((await post({autobuyScenario:'S14+INVALID',enabled:true})).status,400);
  assert.equal((await post({stakeUsdS15:-1})).status,400);
 }finally{child.kill();await new Promise(resolve=>child.exitCode!==null?resolve():child.once('exit',resolve));rmSync(dir,{recursive:true,force:true});}
});
