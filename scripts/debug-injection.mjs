import { chromium } from 'playwright';
import fs from 'fs';

(async () => {
    // We simulate EXACTLY what research-collector.ts does
    const GOLDEN_ENTRY_1M = {
      '2pf': '1', '2ry': '1', '2msa': '1',
      '2nwt': '1', '2hs': '1', '2ch': '1', '2cc': '1',
      '2mihc': '100', '2min24h': '180', '2miv24h': '15000',
      '2mim': '10000', '2mam': '100000', '2im': '1'
    };
    
    const browser = await chromium.launch({ headless: false });
    const context = await browser.newContext();
    
    await context.addInitScript(({ goldenFilter2 }) => {
        if (location.hostname !== 'gmgn.ai') return;
        const storageKey = 'filter_query_map';
        let map = {};
        try {
            const raw = localStorage.getItem(storageKey);
            const parsed = raw ? JSON.parse(raw) : {};
            if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) map = parsed;
        } catch {}
        
        map['trenches2_sol'] = { ...(map['trenches2_sol'] ?? {}), ...goldenFilter2 };
        localStorage.setItem(storageKey, JSON.stringify(map));
    }, { goldenFilter2: GOLDEN_ENTRY_1M });
    
    const page = await context.newPage();
    await page.goto('https://gmgn.ai/?chain=sol', { waitUntil: 'networkidle', timeout: 15000 }).catch(()=>{});
    
    // Dump actual state
    const filterMap = await page.evaluate(() => localStorage.getItem('filter_query_map'));
    console.log("Local Storage after injection:");
    console.log(filterMap);
    
    await browser.close();
})();
