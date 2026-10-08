import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';

(async () => {
    const userDataDir = path.resolve('./profiles/research-vps');
    const browser = await chromium.launchPersistentContext(userDataDir, {
        headless: false,
        args: ['--start-maximized']
    });

    const page = await browser.newPage();
    await page.goto('https://gmgn.ai/?chain=sol', { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(()=>{});
    await page.waitForTimeout(5000);

    const openModal = async () => {
        if (await page.locator('.pi-modal-content').count() > 0) return true;
        
        const filterIcons = page.locator('svg[data-icon="IconFilter16pxRegular"]');
        const count = await filterIcons.count();
        for (let i = 0; i < count; i++) {
            try {
                await filterIcons.nth(i).click({ force: true, timeout: 2000 });
                await page.waitForTimeout(1000);
                if (await page.locator('.pi-modal-content').count() > 0) return true;
            } catch(e) {}
        }
        return false;
    };

    if (!(await openModal())) {
        console.log("Could not open modal.");
        process.exit(1);
    }

    // Get all text labels that could be toggles
    // We'll extract their texts first, so we know what to look for
    const labels = await page.evaluate(() => {
        const modal = document.querySelector('.pi-modal-content') || document.querySelector('.pi-drawer-content-wrapper');
        const all = Array.from(modal.querySelectorAll('*'));
        const texts = [];
        for (let el of all) {
            const text = el.innerText ? el.innerText.trim() : '';
            const lower = text.toLowerCase();
            if (lower === 'cancel' || lower === 'close' || lower === 'apply' || lower === 'save' || lower === 'clear' || lower === 'reset' || lower === 'import/export') continue;
            
            const isLeafWithText = el.childNodes.length === 1 && el.childNodes[0].nodeType === 3 && text.length > 1 && text.length < 30;
            if (isLeafWithText && !texts.includes(text)) {
                texts.push(text);
            }
        }
        return texts;
    });

    console.log(`Found ${labels.length} toggle labels to test.`);
    
    // Clear initial state
    await page.evaluate(() => localStorage.setItem('filter_query_map', '{}'));

    const map = {};

    for (const label of labels) {
        console.log("Testing:", label);
        
        await openModal();
        
        // Find the element and click it
        const el = page.locator('.pi-modal-content').locator(`text="${label}"`).first();
        if (await el.count() > 0) {
            await el.click({ force: true });
            await page.waitForTimeout(300);
            
            // Click apply
            const applyBtn = page.locator('button:has-text("Apply")').first();
            if (await applyBtn.count() > 0) {
                await applyBtn.click({ force: true });
                await page.waitForTimeout(1000);
                
                // Read localStorage
                const val = await page.evaluate(() => localStorage.getItem('filter_query_map'));
                if (val && val !== '{}') {
                    map['[TOGGLE] ' + label] = JSON.parse(val);
                }
                
                // Clear it
                await page.evaluate(() => localStorage.setItem('filter_query_map', '{}'));
            }
        }
    }

    console.log("\n=========================================");
    console.log(JSON.stringify(map, null, 2));
    fs.writeFileSync('filter_analysis_results.json', JSON.stringify(map, null, 2));
    
    await browser.close();
})();
