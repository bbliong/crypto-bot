import { chromium } from 'playwright';

async function clickDevTokenTab() {
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9223');
  const context = browser.contexts()[0];
  const page = await context.newPage();

  const devRequests = [];
  page.on('request', req => {
    const u = req.url();
    if (!u.includes('.png') && !u.includes('.svg') && !u.includes('.jpg') && !u.includes('.webp') && !u.includes('.css') && !u.includes('.js')) {
      devRequests.push({ url: u, method: req.method() });
    }
  });

  page.on('response', async res => {
    const u = res.url();
    if (u.includes('dev') || u.includes('creator') || u.includes('token_created') || u.includes('user_created') || u.includes('wallet_created') || u.includes('launch') || u.includes('deploy')) {
      try {
        const text = await res.text();
        console.log('\n🔥 [DEV-RELATED RESPONSE]');
        console.log('   URL:', u);
        console.log('   Response Body:', text.slice(0, 400));
      } catch {}
    }
  });

  console.log('Navigating to token page...');
  await page.goto('https://gmgn.ai/sol/token/CgyX2y3NYzZipwU4We5Wd2yTuAuwVMaN9cXhaDszzpPZ', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(4000);

  console.log('Finding and clicking "Dev Token" tab in DOM...');
  const clickSuccess = await page.evaluate(() => {
    const all = Array.from(document.querySelectorAll('*'));
    for (const el of all) {
      if (el.children.length === 0 || el.children.length === 1) {
        const text = (el.textContent || '').trim();
        if (text === 'Dev Token' || text.startsWith('Dev Token')) {
          el.click();
          // also click parent if clickable
          if (el.parentElement) el.parentElement.click();
          return { found: true, tag: el.tagName, text: el.textContent };
        }
      }
    }
    return { found: false };
  });

  console.log('Click result:', clickSuccess);
  await page.waitForTimeout(4000);

  // Check what requests occurred after click
  console.log('\n--- Requests Captured (Last 15) ---');
  for (const r of devRequests.slice(-15)) {
    console.log(`[${r.method}] ${r.url}`);
  }

  await page.close();
}

clickDevTokenTab().catch(console.error);
