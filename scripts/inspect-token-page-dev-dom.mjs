import { chromium } from 'playwright';

async function inspectTokenPageDev() {
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9223');
  const context = browser.contexts()[0];
  const page = await context.newPage();

  console.log('Navigating to token page...');
  await page.goto('https://gmgn.ai/sol/token/CgyX2y3NYzZipwU4We5Wd2yTuAuwVMaN9cXhaDszzpPZ', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(5000);

  const devElements = await page.evaluate(() => {
    const results = [];
    // 1. Check all elements containing "Dev" or "Creator"
    const all = Array.from(document.querySelectorAll('*'));
    for (const el of all) {
      const text = (el.textContent || '').trim();
      if (text.includes('Dev') || text.includes('Creator')) {
        if (el.children.length <= 2 && text.length < 100) {
          results.push({ tag: el.tagName, text, html: el.outerHTML.slice(0, 200) });
        }
      }
    }
    // 2. Check all links containing /address/
    const links = Array.from(document.querySelectorAll('a[href*="/address/"]')).map(a => ({
      href: a.href,
      text: a.textContent.trim()
    }));

    return { results: results.slice(0, 15), links: links.slice(0, 15) };
  });

  console.log('DOM Elements mentioning Dev/Creator:');
  console.log(JSON.stringify(devElements.results, null, 2));

  console.log('\nAddress Links on Page:');
  console.log(JSON.stringify(devElements.links, null, 2));

  await page.close();
  process.exit(0);
}

inspectTokenPageDev().catch(console.error);
