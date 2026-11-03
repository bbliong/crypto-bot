import assert from 'node:assert/strict';
import { writeFileSync, unlinkSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { render3ScenariosLiveHtml } from '../scripts/render-3scenarios-live.mjs';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const dataDir = join(__dirname, '../data');
const stateFile = join(dataDir, 'follower-dev-watcher-state.json');

async function run() {
  console.log('Testing Dev Watcher Dashboard UI & API...');

  // 1. Test Active Watching Card
  console.log('1. Testing Active Dev Watcher Card...');
  const activePayload = {
    updatedAt: Date.now(),
    active: true,
    target: {
      mint: '8TpcMFRMZbadz1Qz1ZxoPwQxuHn1jnkewwniYEF1Waek',
      symbol: 'PANDO',
      devWallet: 'QG37oMaWBsov4Cm9mgP1vHPXn8NMVtcd5pUvmQDENGa',
      ipfsUri: 'https://ipfs.io/ipfs/bafkreic3lgnfczlyjizqp274vacpn45lxye677ymhbvlbxeeszlnpc5rum',
      ipfsHash: 'bafkreic3lgnfczlyjizqp274vacpn45lxye677ymhbvlbxeeszlnpc5rum',
      subscribedAt: Date.now()
    }
  };
  writeFileSync(stateFile, JSON.stringify(activePayload, null, 2), 'utf8');

  const htmlActive = render3ScenariosLiveHtml();
  assert(htmlActive.includes('ACTIVE 1-DEV RADAR'), 'Must contain header title');
  assert(htmlActive.includes('🟢 AKTIF MEMANTAU 1 DEV (LISTENING WS)'), 'Must show active pill');
  assert(htmlActive.includes('PANDO'), 'Must show watched symbol');
  assert(htmlActive.includes('QG37oMaWBsov'), 'Must show dev wallet address');
  assert(htmlActive.includes('bafkreic3lgnfczlyjizqp274vacpn45lxye677ymhbvlbxeeszlnpc5rum'), 'Must show IPFS hash');
  console.log('   ✅ Active Dev Watcher UI card verified');

  // 2. Test Idle / Standby Card
  console.log('\n2. Testing Idle / Standby Card...');
  const idlePayload = {
    updatedAt: Date.now(),
    active: false,
    target: null
  };
  writeFileSync(stateFile, JSON.stringify(idlePayload, null, 2), 'utf8');

  const htmlIdle = render3ScenariosLiveHtml();
  assert(htmlIdle.includes('⚪ STANDBY / IDLE'), 'Must show standby pill when idle');
  assert(htmlIdle.includes('Belum ada dev yang dikunci'), 'Must show standby explanation');
  console.log('   ✅ Idle Dev Watcher UI card verified');

  console.log('\n🎉 ALL Dev Watcher Dashboard UI tests passed successfully!');
}

run().catch(err => {
  console.error('❌ Test failed:', err);
  process.exit(1);
});
