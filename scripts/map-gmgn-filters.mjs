import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';
import readline from 'readline';

const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
});

(async () => {
    console.log("=========================================");
    console.log(" GMGN Filter Analyzer via Playwright");
    console.log("=========================================");
    console.log("Membuka browser dengan profile: research-vps...");
    
    const userDataDir = path.resolve('./profiles/research-vps');
    
    const browser = await chromium.launchPersistentContext(userDataDir, {
        headless: false,
        args: ['--start-maximized']
    });

    const page = await browser.newPage();
    console.log("Navigasi ke gmgn.ai...");
    await page.goto('https://gmgn.ai/?chain=sol', { waitUntil: 'domcontentloaded' });
    
    console.log(`
INTRUKSI:
1. Silakan login (jika belum).
2. Pergi ke tab yang Anda inginkan (misal Trenches).
3. Buka modal Filter.
4. Kosongkan/Reset semua filter agar bersih (Clear All).
`);

    await new Promise(resolve => rl.question("Tekan ENTER jika modal filter sudah terbuka dan bersih... ", resolve));

    console.log("\n[!] Meng-inject script analyzer ke dalam browser...");

    // Inject listener to the page
    await page.exposeFunction('logFilterChange', (text, diff) => {
        console.log(`\n[+] Elemen di-klik: "${text.trim()}"`);
        console.log(`    Perubahan di filter_query_map:`, JSON.stringify(diff, null, 2));
    });

    await page.evaluate(() => {
        window.__lastFilterMap = localStorage.getItem('filter_query_map');
        
        document.addEventListener('click', (e) => {
            // Get text of clicked element or its closest parent with text
            let text = e.target.innerText || e.target.textContent || '';
            if (!text.trim() && e.target.parentElement) {
                text = e.target.parentElement.innerText || e.target.parentElement.textContent || '';
            }
            // limit text length
            text = text.substring(0, 50).replace(/\n/g, ' ');

            // Check localStorage after a short delay to let react state update it
            setTimeout(() => {
                const currentMap = localStorage.getItem('filter_query_map');
                if (currentMap !== window.__lastFilterMap) {
                    let oldObj = {};
                    let newObj = {};
                    try { oldObj = window.__lastFilterMap ? JSON.parse(window.__lastFilterMap) : {}; } catch(e){}
                    try { newObj = currentMap ? JSON.parse(currentMap) : {}; } catch(e){}
                    
                    // find differences
                    const diff = {};
                    for (const key in newObj) {
                        const oldSub = oldObj[key] || {};
                        const newSub = newObj[key] || {};
                        const subDiff = {};
                        
                        // Compare subkeys (like "4pf", "9mihc")
                        let changed = false;
                        for (const subKey in newSub) {
                            if (newSub[subKey] !== oldSub[subKey]) {
                                subDiff[subKey] = newSub[subKey];
                                changed = true;
                            }
                        }
                        for (const subKey in oldSub) {
                            if (newSub[subKey] === undefined) {
                                subDiff[subKey] = "[REMOVED]";
                                changed = true;
                            }
                        }
                        
                        if (changed) {
                            diff[key] = subDiff;
                        }
                    }
                    
                    window.__lastFilterMap = currentMap;
                    
                    // Send to node terminal if there's a diff
                    if (Object.keys(diff).length > 0) {
                        window.logFilterChange(text, diff);
                    }
                }
            }, 300); // 300ms delay to allow localStorage write
        }, true);
    });

    console.log(`
✅ Analyzer aktif!
Sekarang, silakan KLIK SATU PER SATU filter yang ada di browser.
Script ini akan otomatis mendeteksi setiap kali Anda mengklik filter, dan akan mem-print "kode" apa yang tersimpan di localStorage.

Tekan Ctrl+C di terminal ini jika sudah selesai menganalisa.
`);

})();
