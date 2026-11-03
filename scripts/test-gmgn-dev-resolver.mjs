import { chromium } from 'playwright';

async function testGmgnDevResolver() {
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9223');
  const context = browser.contexts()[0];
  const page = context.pages().find(p => p.url().includes('gmgn.ai'));
  if (!page) {
    console.error('No GMGN page');
    process.exit(1);
  }

  const mint1 = '6N7Dd6eHygw4gHo8c4M1hJJRMAn6oquWCnyFvmXDhazX'; // 404 Pool 1
  const mint2 = 'CgyX2y3NYzZipwU4We5Wd2yTuAuwVMaN9cXhaDszzpPZ'; // 404 Pool 2

  console.log('1. Resolving dev for Pool 1 via GMGN...');
  const dev1 = await page.evaluate(async (m) => {
    try {
      const resp = await fetch(`/vas/api/v1/token_holders/sol/${m}?limit=50&orderby=amount_percentage&direction=desc`);
      const json = await resp.json();
      const list = json?.data?.list || [];
      const creator = list.find(h => (h.maker_token_tags || []).includes('creator'));
      return creator ? creator.address : null;
    } catch (e) {
      return null;
    }
  }, mint1);
  console.log('   ✅ Pool 1 Creator from GMGN:', dev1);

  console.log('2. Resolving dev for Pool 2 via GMGN...');
  const dev2 = await page.evaluate(async (m) => {
    try {
      const resp = await fetch(`/vas/api/v1/token_holders/sol/${m}?limit=50&orderby=amount_percentage&direction=desc`);
      const json = await resp.json();
      const list = json?.data?.list || [];
      const creator = list.find(h => (h.maker_token_tags || []).includes('creator'));
      return creator ? creator.address : null;
    } catch (e) {
      return null;
    }
  }, mint2);
  console.log('   ✅ Pool 2 Creator from GMGN:', dev2);

  console.log('3. Fetching Dev Created Tokens for', dev1, '...');
  const devTokens = await page.evaluate(async (dev) => {
    try {
      const resp = await fetch(`/api/v1/dev_created_tokens/sol/${dev}`);
      const json = await resp.json();
      return json?.data?.tokens || [];
    } catch (e) {
      return [];
    }
  }, dev1);

  console.log(`   ✅ Dev created total ${devTokens.length} tokens!`);
  for (const t of devTokens.slice(0, 5)) {
    console.log(`      -> [${t.symbol}] ${t.token_address} | Created at: ${new Date(t.create_timestamp * 1000).toLocaleTimeString()} | Pool: ${t.biggest_pool}`);
  }

  process.exit(0);
}

testGmgnDevResolver().catch(console.error);
