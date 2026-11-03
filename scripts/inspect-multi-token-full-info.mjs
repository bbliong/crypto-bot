import { chromium } from 'playwright';

async function fetchTokenFullInfo() {
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9223');
  const context = browser.contexts()[0];
  const page = context.pages().find(p => p.url().includes('gmgn.ai'));
  if (!page) {
    console.error('No GMGN tab found');
    process.exit(1);
  }

  const mint = 'CgyX2y3NYzZipwU4We5Wd2yTuAuwVMaN9cXhaDszzpPZ';
  const result = await page.evaluate(async (m) => {
    // 1. Test POST /mrwapi/v1/multi_token_full_info
    const fullInfoRes = await fetch('/mrwapi/v1/multi_token_full_info', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify([{ chain: 'sol', address: m }]),
      credentials: 'include'
    }).then(r => r.json()).catch(e => ({ error: e.message }));

    return fullInfoRes;
  }, mint);

  console.log('Result from /mrwapi/v1/multi_token_full_info:');
  console.log('Data:', JSON.stringify(result?.data, null, 2));

  process.exit(0);
}

fetchTokenFullInfo().catch(err => {
  console.error(err);
  process.exit(1);
});
