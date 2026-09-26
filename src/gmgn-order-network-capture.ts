import { chromium, type Request, type Response } from 'playwright';
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { amountInput, applyExecutionSettings, fetchSolUsdSpot, fetchSolUsdSpotInBrowser, selectSellPercent, selectTradeSide, usdcToSol } from './gmgn-trade-ui.js';
import { DEFAULT_EXECUTION_SETTINGS } from './execution-settings.js';

const { values } = parseArgs({ options: {
  token: { type: 'string' },
  mode: { type: 'string', default: 'buy' },
  buyUsdc: { type: 'string', default: '5' },
  sellPercent: { type: 'string', default: '100' },
  output: { type: 'string' },
  profileDir: { type: 'string', default: 'profiles/order-network-capture' },
  profileName: { type: 'string', default: 'Default' },
  bodyLimitKb: { type: 'string', default: '512' },
  enableExtensions: { type: 'boolean', default: true },
} });

const bodyLimitBytes = Number(values.bodyLimitKb) * 1024;
if (!Number.isInteger(bodyLimitBytes) || bodyLimitBytes < 1_024 || bodyLimitBytes > 10 * 1024 * 1024) {
  throw new Error('--bodyLimitKb must be an integer from 1 to 10240.');
}
if (!values.token || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(values.token)) throw new Error('Provide a Solana token mint with --token.');
if (!['buy', 'sell'].includes(values.mode!)) throw new Error('--mode must be buy or sell.');
const buyUsdc = Number(values.buyUsdc), sellPercent = Number(values.sellPercent);
if (!Number.isFinite(buyUsdc) || buyUsdc <= 0) throw new Error('--buyUsdc must be positive.');
if (!Number.isInteger(sellPercent) || sellPercent < 1 || sellPercent > 100) throw new Error('--sellPercent must be an integer from 1 to 100.');
const targetUrl = `https://gmgn.ai/sol/token/${values.token}`;

const runId = new Date().toISOString().replace(/[:.]/g, '-');
const output = values.output || join('research', `order-network-capture-${runId}`);
mkdirSync(output, { recursive: true });
const logPath = join(output, 'network.jsonl');
const sensitiveKey = /(?:authorization|cookie|api[ _-]?key|route[ _-]?key|secret|private|password|seed|signature|signed.?tx|swap.?transaction)/i;
const requestIds = new WeakMap<Request, number>();
let sequence = 0;

function write(value: unknown) {
  appendFileSync(logPath, JSON.stringify(value) + '\n');
}

function redact(value: unknown, depth = 0): unknown {
  if (depth > 12) return '[truncated: nesting limit]';
  if (Array.isArray(value)) return value.slice(0, 500).map(item => redact(item, depth + 1));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, sensitiveKey.test(key) ? '[redacted]' : redact(item, depth + 1)]));
  if (typeof value === 'string' && value.length > bodyLimitBytes) return value.slice(0, bodyLimitBytes) + '[truncated]';
  return value;
}

function safeUrl(rawUrl: string) {
  const url = new URL(rawUrl);
  for (const key of [...url.searchParams.keys()]) if (sensitiveKey.test(key)) url.searchParams.set(key, '[redacted]');
  return url.toString();
}

function safeRequestBody(request: Request) {
  const raw = request.postData();
  if (!raw) return null;
  const bytes = Buffer.byteLength(raw);
  const contentType = request.headers()['content-type'] ?? '';
  if (!/json/i.test(contentType)) return { kind: 'non-json', bytes, body: '[not recorded]' };
  try { return { kind: 'json', bytes, body: redact(JSON.parse(raw)) }; }
  catch { return { kind: 'invalid-json', bytes, body: '[not recorded]' }; }
}

async function safeResponseBody(response: Response) {
  const contentType = response.headers()['content-type'] ?? '';
  if (!/json/i.test(contentType)) return { kind: 'non-json', body: '[not recorded]' };
  const raw = await response.text().catch(() => null);
  if (raw === null) return { kind: 'unavailable', body: '[not recorded]' };
  const bytes = Buffer.byteLength(raw);
  if (bytes > bodyLimitBytes) return { kind: 'json', bytes, body: '[not recorded: exceeds body limit]' };
  try { return { kind: 'json', bytes, body: redact(JSON.parse(raw)) }; }
  catch { return { kind: 'invalid-json', bytes, body: '[not recorded]' }; }
}

async function main() {
  writeFileSync(join(output, 'manifest.json'), JSON.stringify({
    runId, startedAt: new Date().toISOString(), purpose: 'Passive GMGN browser network capture. The script never clicks Buy or Sell.',
    redaction: 'Authorization, cookies, API keys, private keys, seed phrases, signatures, signed transactions, and unsigned swap transactions are redacted. Only JSON bodies up to the configured limit are recorded.',
    bodyLimitKb: Number(values.bodyLimitKb), url: targetUrl, mode: values.mode, buyUsdc, sellPercent, executionSettings: DEFAULT_EXECUTION_SETTINGS,
  }, null, 2));

  const context = await chromium.launchPersistentContext(values.profileDir, {
    channel: 'chrome', headless: false, viewport: null,
    args: ['--start-maximized', '--profile-directory=' + values.profileName],
    ignoreDefaultArgs: values.enableExtensions ? ['--disable-extensions'] : undefined,
  });
  const attachNetworkCapture = (page: Awaited<ReturnType<typeof context.newPage>>) => {
    const recordRequest = (request: Request) => {
    const id = ++sequence;
    requestIds.set(request, id);
    write({ type: 'REQUEST', id, observedAt: new Date().toISOString(), method: request.method(), resourceType: request.resourceType(),
      url: safeUrl(request.url()), headerNames: Object.keys(request.headers()).sort(), body: safeRequestBody(request) });
    };
    page.on('request', recordRequest);
    page.on('requestfailed', request => write({ type: 'REQUEST_FAILED', id: requestIds.get(request) ?? null, observedAt: new Date().toISOString(), method: request.method(), url: safeUrl(request.url()), failure: request.failure()?.errorText ?? 'unknown' }));
    page.on('response', async response => write({ type: 'RESPONSE', id: requestIds.get(response.request()) ?? null, observedAt: new Date().toISOString(), method: response.request().method(), status: response.status(),
      resourceType: response.request().resourceType(), url: safeUrl(response.url()), headerNames: Object.keys(response.headers()).sort(), contentType: response.headers()['content-type'] ?? null, body: await safeResponseBody(response) }));
  };
  for (const page of context.pages()) attachNetworkCapture(page);
  context.on('page', attachNetworkCapture);

  const preparePanel = async (side: 'buy' | 'sell') => {
    const page = side === 'buy' ? (context.pages()[0] ?? await context.newPage()) : await context.newPage();
    await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    await page.locator('[data-sentry-component="Types"]').waitFor({ state: 'visible', timeout: 30_000 });
    await selectTradeSide(page, side);
    await applyExecutionSettings(page, DEFAULT_EXECUTION_SETTINGS);
    if (side === 'buy') {
      let solUsdSpot: number;
      try { solUsdSpot = await fetchSolUsdSpot(); } catch { solUsdSpot = await fetchSolUsdSpotInBrowser(page); }
      const amountSol = usdcToSol(String(buyUsdc), solUsdSpot);
      await (await amountInput(page)).fill(amountSol);
      write({ type: 'UI_PREFILLED', observedAt: new Date().toISOString(), side, requestedUsdc: buyUsdc, amountSol, solUsdSpot, executionSettings: DEFAULT_EXECUTION_SETTINGS });
    } else {
      await selectSellPercent(page, sellPercent);
      write({ type: 'UI_PREFILLED', observedAt: new Date().toISOString(), side, sellPercent, executionSettings: DEFAULT_EXECUTION_SETTINGS });
    }
    return page;
  };
  const page = await preparePanel(values.mode as 'buy' | 'sell');
  await page.bringToFront();
  console.log('[network-capture-start]', output);
  console.log(`Satu tab GMGN sudah dipersiapkan pada panel ${values.mode === 'buy' ? 'Buy' : 'Sell'}. Setelah Buy manual, Anda dapat beralih ke Sell pada tab yang sama; seluruh request/response tetap direkam. Script ini tidak mengklik tombol transaksi. Tekan Ctrl+C setelah selesai.`);
  await new Promise<void>(resolve => { process.once('SIGINT', resolve); process.once('SIGTERM', resolve); });
  await context.close();
  console.log('[network-capture-saved]', logPath);
}

void main().catch(error => { console.error(error); process.exitCode = 1; });
