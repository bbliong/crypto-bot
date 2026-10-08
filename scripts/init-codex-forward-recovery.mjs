// Explicit provenance fork: frozen replay rules stay unchanged; live config is not consumed.
import {readFileSync,writeFileSync,existsSync,mkdirSync,readdirSync,copyFileSync,constants} from 'node:fs';
import assert from 'node:assert/strict';
import {studyHash} from './codex-cached-opportunity-study.mjs';
const parent='reports/codex-online-forward-v17',root='reports/codex-online-forward-v17r1';
assert.ok(!existsSync(root),'Recovery already initialized; do not overwrite it');
const manifest=JSON.parse(readFileSync(`${parent}/manifest.json`));
const changes=Object.entries(manifest.hashes).filter(([p,h])=>studyHash(p)!==h);
assert.deepEqual(changes.map(([p])=>p),['config/autobuy-settings.json']);
if(existsSync(`${parent}/worker.lock`)){
  const lock=JSON.parse(readFileSync(`${parent}/worker.lock`));
  assert.throws(()=>process.kill(lock.pid,0),{code:'ESRCH'},'Parent worker must be stopped');
}
const files=readdirSync(`${parent}/snapshots`).filter(x=>x.endsWith('.json')).sort();
assert.ok(files.length,'Need a completed parent snapshot');
const snapshotPath=`${parent}/snapshots/${files.at(-1)}`,snapshot=JSON.parse(readFileSync(snapshotPath));
mkdirSync(root);mkdirSync(`${root}/decisions`);
for(const name of ['initial-universe.json','seed-labels.json','sessions.jsonl'])
  copyFileSync(`${parent}/${name}`,`${root}/${name}`,constants.COPYFILE_EXCL);
for(const name of readdirSync(`${parent}/decisions`))
  copyFileSync(`${parent}/decisions/${name}`,`${root}/decisions/${name}`,constants.COPYFILE_EXCL);
// Existing journal case references remain immutable parent paths. Never rewrite past decisions.
const recovery={at:new Date().toISOString(),parentManifest:`${parent}/manifest.json`,parentManifestHash:studyHash(`${parent}/manifest.json`),
  parentSnapshot:snapshotPath,parentSnapshotHash:studyHash(snapshotPath),
  reason:'Dead worker, then protected config changed externally. Replay constants and all executable dependencies unchanged.',
  configChange:changes.map(([path,previousHash])=>({path,previousHash,currentHash:studyHash(path)})),
  comparability:'Same frozen replay algorithm; not an uninterrupted prospective capture. Catch-up uses surviving raw data.',liveAllowed:false};
const hashes={...manifest.hashes};
for(const [path]of changes)hashes[path]=studyHash(path);
for(const path of ['scripts/run-codex-online-forward-v17r1.mjs','scripts/init-codex-forward-recovery.mjs',
  'docs/CODEX_FORWARD_RECOVERY_V17R1.md',`${root}/initial-universe.json`,`${root}/seed-labels.json`])hashes[path]=studyHash(path);
writeFileSync(`${root}/manifest.json`,JSON.stringify({...manifest,recovery,hashes}),{flag:'wx',mode:0o600});
writeFileSync(`${root}/latest-status.json`,JSON.stringify({status:'RECOVERY_INITIALIZED',active:false,lastCutoff:snapshot.cutoff,
  latestLedger:snapshot.ledger,updatedAt:new Date().toISOString(),liveAllowed:false}),{flag:'wx',mode:0o600});
console.log(JSON.stringify(recovery));
