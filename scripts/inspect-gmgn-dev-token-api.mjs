import { chromium } from 'playwright';

async function inspectGmgnToken() {
  console.log('Connecting to Chrome CDP at http://127.0.0.1:9223...');
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9223');
  const context = browser.contexts()[0] || await browser.newContext();
  const page = await context.newPage();

  console.log('Listening to network requests...');
  const devEndpoints = [];

  page.on('request', req => {
    const url = req.url();
    if (url.includes('dev') || url.includes('creator') || url.includes('wallet') || url.includes('tokens') || url.includes('stat') || url.includes('pool')) {
      if (!url.includes('.png') && !url.includes('.jpg') && !url.includes('.svg') && !url.includes('.webp')) {
        devEndpoints.push({ type: 'REQ', method: req.method(), url });
      }
    }
  });

  page.on('response', async res => {
    const url = res.url();
    if (url.includes('dev') || url.includes('creator') || url.includes('created') || url.includes('launch') || url.includes('deploy')) {
      try {
        const text = await res.text();
        console.log('\n🎯 [FOUND MATCHING API ENDPOINT]');
        console.log('   URL:', url);
        console.log('   Status:', res.status());
        console.log('   Sample Body:', text.slice(0, 300));
        devEndpoints.push({ type: 'RES', url, status: res.status(), body: text.slice(0, 500) });
      } catch {}
    }
  });

  const targetUrl = 'https://gmgn.ai/sol/token/CgyX2y3NYzZipwU4We5Wd2yTuAuwVMaN9cXhaDszzpPZ';
  console.log(`Navigating to ${targetUrl}...`);
  await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(5000);

  // Look for "Dev" or "Dev Token" or "Creator" tab/button in DOM and click it
  console.log('Searching for Dev Token tab in DOM...');
  const clicked = await page.evaluate(() => {
    const elements = Array.from(document.querySelectorAll('button, div, span, a'));
    const devBtn = elements.find(el => {
      const txt = (el.textContent || '').trim().toLowerCase();
      return (txt.includes('dev token') || txt === 'dev' || txt.includes('dev_token') || txt.includes('creator tokens') || txt.includes('dev tokens'));
    });
    if (devBtn) {
      devBtn.click();
      return devBtn.textContent.trim();
    }
    return null;
  });

  if (clicked) {
    console.log(`✅ Clicked on tab: "${clicked}"! Waiting for requests...`);
    await page.waitForTimeout(5000);
  } else {
    console.log('⚠️ Could not find explicit button text for Dev Token. Evaluating all tabs on page...');
    const tabs = await page.evaluate(() => {
      return Array.from(document.querySelectorAll('[role="tab"], button, .tab, a')).map(e => e.textContent.trim()).filter(t => t.length > 0 && t.length < 30);
    });
    console.log('Available tabs/buttons:', tabs.slice(0, 25));
  }

  // Also extract any creator or dev address from page state
  const pageDevInfo = await page.evaluate(() => {
    const text = document.body.innerText;
    const matches = text.match(/Dev/i);
    return {
      title: document.title,
      hasDevWord: !!matches
    };
  });
  console.log('Page info:', pageDevInfo);

  await page.waitForTimeout(3000);
  await page.close();
  console.log('\nTotal relevant endpoints captured:', devEndpoints.length);
}

inspectGmgnToken().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
