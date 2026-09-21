import { createServer } from 'node:http';
import { readFile, readdir, stat } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../dist/', import.meta.url));
const researchRoot = fileURLToPath(new URL('../research/', import.meta.url));
const types = { '.html':'text/html; charset=utf-8', '.json':'application/json; charset=utf-8', '.js':'text/javascript; charset=utf-8', '.css':'text/css; charset=utf-8', '.svg':'image/svg+xml' };
async function researchPreview() {
  const entries = await readdir(researchRoot, { withFileTypes: true });
  const studies = await Promise.all(entries.filter(entry => entry.isDirectory() && entry.name.startsWith('screening-study-')).map(async entry => ({ name: entry.name, changed: (await stat(join(researchRoot, entry.name))).mtimeMs })));
  const latest = studies.sort((a, b) => b.changed - a.changed)[0];
  if (!latest) return { generatedAt: Date.now(), rows: [], summary: null };
  const folder = join(researchRoot, latest.name), file = join(folder, 'screening-rejected-young.jsonl');
  const text = await readFile(file, 'utf8').catch(() => '');
  const rows = text.split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line)).slice(-250).reverse().map(row => {
    const createdAt = row.fields?.createdAt?.value;
    return { mint: row.mint, name: row.metadata?.name ?? null, symbol: row.metadata?.symbol ?? null, imageUrl: row.metadata?.imageUrl ?? null, observedAt: row.observedAt,
      ageSeconds: typeof createdAt === 'number' ? Math.max(0, (row.observedAt - createdAt) / 1000) : null,
      holders: row.fields?.holders?.value ?? null, liquidityUsd: row.fields?.liquidityUsd?.value ?? null,
      reasons: row.checks?.map(check => ({ name: check.name, status: check.status, detail: check.detail })) ?? [] };
  });
  const summary = JSON.parse(await readFile(join(folder, 'screening-young-rejection-summary.json'), 'utf8').catch(() => 'null'));
  return { generatedAt: Date.now(), runFolder: latest.name, rows, summary };
}
async function runHistory() {
  const entries = await readdir(researchRoot, { withFileTypes: true });
  const runs = await Promise.all(entries.filter(entry => entry.isDirectory()).map(async entry => {
    const folder = join(researchRoot, entry.name);
    const manifest = JSON.parse(await readFile(join(folder, 'manifest.json'), 'utf8').catch(() => 'null'));
    if (!manifest?.startedAt) return null;
    const rows = (await readFile(join(folder, 'simulated-trades.jsonl'), 'utf8').catch(() => '')).split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
    const buys = rows.filter(row => row.type === 'SIMULATED_BUY');
    const sells = rows.filter(row => row.type === 'SIMULATED_SELL');
    return { folder: entry.name, startedAt: manifest.startedAt, changed: (await stat(folder)).mtimeMs,
      buys: buys.length, sells: sells.length, open: buys.length - sells.length,
      pnlUsd: sells.reduce((total, row) => total + (Number(row.pnlUsd) || 0), 0),
      reportAvailable: Boolean(await readFile(join(folder, 'simulation-report.html')).catch(() => null)) };
  }));
  return { generatedAt: Date.now(), runs: runs.filter(Boolean).sort((a, b) => b.changed - a.changed) };
}
createServer(async (req, res) => {
  const path = new URL(req.url ?? '/', 'http://127.0.0.1').pathname;
  if (path === '/research-preview-data.json') {
    try { res.writeHead(200, { 'content-type':'application/json; charset=utf-8', 'cache-control':'no-store' }).end(JSON.stringify(await researchPreview())); }
    catch { res.writeHead(500).end('Research preview unavailable'); }
    return;
  }
  if (path === '/research-run-history.json') {
    try { res.writeHead(200, { 'content-type':'application/json; charset=utf-8', 'cache-control':'no-store' }).end(JSON.stringify(await runHistory())); }
    catch { res.writeHead(500).end('Run history unavailable'); }
    return;
  }
  if (path.startsWith('/research-report/')) {
    const folder = decodeURIComponent(path.slice('/research-report/'.length));
    if (!/^[A-Za-z0-9._-]+$/.test(folder)) { res.writeHead(403).end(); return; }
    try { const data = await readFile(join(researchRoot, folder, 'simulation-report.html')); res.writeHead(200, { 'content-type':'text/html; charset=utf-8', 'cache-control':'no-store' }).end(data); }
    catch { res.writeHead(404).end('Run report not found'); }
    return;
  }
  const requested = path === '/' ? 'index.html' : path.replace(/^\/+/, '');
  const target = normalize(join(root, requested));
  if (!target.startsWith(normalize(root))) { res.writeHead(403).end(); return; }
  try { const data = await readFile(target); res.writeHead(200, { 'content-type': types[extname(target)] ?? 'application/octet-stream', 'cache-control':'no-store' }).end(data); }
  catch { res.writeHead(404).end('Not found'); }
}).listen(4173, '127.0.0.1', () => console.log('Dashboard: http://127.0.0.1:4173'));
