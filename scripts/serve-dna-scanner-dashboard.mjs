import { createServer } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderDnaScannerHtml } from './render-dna-scanner-html.mjs';

const PORT = 4196;
const __dirname = fileURLToPath(new URL('.', import.meta.url));
const dataDir = join(__dirname, '../data');
const storeFile = join(dataDir, 'dna-clone-wallets.json');

const server = createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = url.pathname;

  // Handle API endpoint
  if (pathname.includes('/api/wallets')) {
    let list = [];
    if (existsSync(storeFile)) {
      try {
        list = JSON.parse(readFileSync(storeFile, 'utf8'));
      } catch {}
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ok: true, count: list.length, wallets: list }));
  }

  // Handle Main HTML Dashboard (accepts /, /clone-radar, etc.)
  const activeTab = url.searchParams.get('tab') || 'elite';
  const html = renderDnaScannerHtml(activeTab);
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(html);
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[DNA-SCANNER-DASHBOARD] Berjalan di port ${PORT} (http://127.0.0.1:${PORT})`);
});
