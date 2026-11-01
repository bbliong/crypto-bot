#!/usr/bin/env node
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const file = join(process.cwd(), 'data', 'follower-autobuy-settings.json');
const current = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : { enabled: false };

const arg = (process.argv[2] || '').toLowerCase();

if (arg === 'on' || arg === '1' || arg === 'true') {
  current.enabled = true;
  current.updatedAt = Date.now();
  writeFileSync(file, JSON.stringify(current, null, 2), 'utf8');
  console.log('✅ Real Auto-Buy: [ ON / AKTIF ] (Order swap nyata akan dikirim ke GMGN API/blockchain)');
} else if (arg === 'off' || arg === '0' || arg === 'false') {
  current.enabled = false;
  current.updatedAt = Date.now();
  writeFileSync(file, JSON.stringify(current, null, 2), 'utf8');
  console.log('⚪ Real Auto-Buy: [ OFF / NONAKTIF ] (Mode simulasi swap saja, order nyata tidak dikirim)');
} else {
  console.log(`Status Saat Ini: Real Auto-Buy = [ ${current.enabled ? 'ON / AKTIF' : 'OFF / NONAKTIF'} ]`);
  console.log('Penggunaan:');
  console.log('  node scripts/toggle-autobuy.mjs on   -> Mengaktifkan hit API order nyata');
  console.log('  node scripts/toggle-autobuy.mjs off  -> Menonaktifkan (hanya simulasi swap saja)');
  console.log('  node scripts/toggle-autobuy.mjs      -> Cek status');
}
