import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const defaultRoot = fileURLToPath(new URL('../', import.meta.url));

export async function fetchHeliusUsage(root = defaultRoot) {
  let key = process.env.HELIUS_API_KEY || '';
  let projectId = process.env.HELIUS_PROJECT_ID || '';

  try {
    const envPath = join(root, '.env');
    if (existsSync(envPath)) {
      const content = readFileSync(envPath, 'utf8');
      const km = content.match(/HELIUS_API_KEY=([^\s\r\n]+)/);
      if (km) key = km[1].trim();
      const pm = content.match(/HELIUS_PROJECT_ID=([^\s\r\n]+)/);
      if (pm) projectId = pm[1].trim();
    }
  } catch {}

  if (!key || !projectId) {
    throw new Error('HELIUS_API_KEY atau HELIUS_PROJECT_ID belum diset di .env');
  }

  const url = `https://admin-api.helius.xyz/v0/admin/projects/${projectId}/usage?api-key=${key}`;
  const resp = await fetch(url);
  if (!resp.ok) {
    throw new Error(`Gagal fetch usage Helius: HTTP ${resp.status} ${await resp.text()}`);
  }
  return resp.json();
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  fetchHeliusUsage().then(usage => {
    const pctUsed = ((usage.creditsUsed / usage.subscriptionDetails.creditsLimit) * 100).toFixed(2);
    const pctRemain = ((usage.creditsRemaining / usage.subscriptionDetails.creditsLimit) * 100).toFixed(2);
    console.log('\n📊 STATUS KUOTA HELIUS REALTIME');
    console.log('='.repeat(45));
    console.log(`Plan              : ${usage.subscriptionDetails.plan.toUpperCase()}`);
    console.log(`Credit Limit      : ${usage.subscriptionDetails.creditsLimit.toLocaleString()} credits`);
    console.log(`Credits Terpakai  : ${usage.creditsUsed.toLocaleString()} (${pctUsed}%)`);
    console.log(`Credits Tersisa   : ${usage.creditsRemaining.toLocaleString()} (${pctRemain}%)`);
    console.log(`Siklus Billing    : ${usage.creditCycle.start} s/d ${usage.creditCycle.end}`);
    console.log('\nBreakdown Pemakaian:');
    console.log(`- RPC Requests    : ${usage.credits.rpc.toLocaleString()} credits (${usage.requests.rpc} requests)`);
    console.log(`- WebSocket Stream: ${usage.credits.laserstreamWebsocket.toLocaleString()} credits (${(usage.dataTransfer.laserstreamWebsocket / 1024 / 1024).toFixed(2)} MB data)`);
    console.log(`- Webhook         : ${usage.credits.webhooks.toLocaleString()} credits`);
    console.log('='.repeat(45) + '\n');
  }).catch(err => {
    console.error('Error:', err.message);
    process.exit(1);
  });
}
