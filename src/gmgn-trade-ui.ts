import { chromium, type Locator, type Page } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { parseArgs } from 'node:util';
import { DEFAULT_EXECUTION_SETTINGS, type ExecutionSettings } from './execution-settings.js';

export type TradeSide = 'buy' | 'sell';
export type TradePanelState = {
  tokenUrl: string;
  side: TradeSide;
  amount: string | null;
  amountUnit: 'SOL' | 'token';
  amountSource: 'sol' | 'usdc-conversion' | 'token-amount' | 'sell-percent-preset';
  requestedUsdc: number | null;
  requestedSellPercent: number | null;
  solUsdSpot: number | null;
  executionSettings: ExecutionSettings;
  executionSettingsApplied: boolean;
  extensionsEnabled: boolean;
  amountInputFound: boolean;
  submitButtonFound: boolean;
  submitDisabled: boolean | null;
  advancedAvailable: boolean;
  prepared: boolean;
  checkedAt: string;
};

export function normalizeAmount(value: string): string {
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount <= 0 || amount > 1_000_000) throw new Error('Amount must be a positive finite number.');
  return String(amount);
}

export async function fetchSolUsdSpot(): Promise<number> {
  try {
    const response = await fetch('https://api.coinbase.com/v2/prices/SOL-USD/spot', {
      headers: { accept: 'application/json' },
    });
    if (!response.ok) throw new Error(`Coinbase returned ${response.status}.`);
    const payload = await response.json() as { data?: { amount?: string } };
    const price = Number(payload.data?.amount);
    if (!Number.isFinite(price) || price <= 0) throw new Error('Coinbase returned an invalid SOL/USD spot price.');
    return price;
  } catch {
    // Public fallback when the local Node TLS store rejects Coinbase's
    // certificate. It is still a fresh market quote, never a cached price.
    const response = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd', {
      headers: { accept: 'application/json' },
    });
    if (!response.ok) throw new Error(`Could not get SOL/USD spot price (${response.status}).`);
    const payload = await response.json() as { solana?: { usd?: number } };
    const price = Number(payload.solana?.usd);
    if (!Number.isFinite(price) || price <= 0) throw new Error('CoinGecko returned an invalid SOL/USD spot price.');
    return price;
  }
}

export async function fetchSolUsdSpotInBrowser(page: Page): Promise<number> {
  const amount = await page.evaluate(async () => {
    const response = await fetch('https://api.coinbase.com/v2/prices/SOL-USD/spot', {
      headers: { accept: 'application/json' },
    });
    if (!response.ok) throw new Error(`Could not get SOL/USD spot price (${response.status}).`);
    const payload = await response.json() as { data?: { amount?: string } };
    return payload.data?.amount;
  });
  const price = Number(amount);
  if (!Number.isFinite(price) || price <= 0) throw new Error('Browser returned an invalid SOL/USD spot price.');
  return price;
}

export function usdcToSol(usdc: string, solUsdSpot: number, decimals = 3): string {
  const requested = Number(usdc);
  if (!Number.isFinite(requested) || requested <= 0 || requested > 1_000_000) {
    throw new Error('USDC amount must be a positive finite number.');
  }
  if (!Number.isFinite(solUsdSpot) || solUsdSpot <= 0) throw new Error('SOL spot price must be positive.');
  const sol = requested / solUsdSpot;
  const formatted = Math.max(sol, 10 ** -decimals).toFixed(decimals);
  return normalizeAmount(formatted);
}

async function waitForWindowCloseRequest(): Promise<void> {
  await new Promise<void>(resolve => {
    process.once('SIGINT', resolve);
    process.once('SIGTERM', resolve);
  });
}

function sideLabel(side: TradeSide) { return side === 'buy' ? 'Beli' : 'Jual'; }
function sidePattern(side: TradeSide) { return side === 'buy' ? /^(Beli|Buy)$/i : /^(Jual|Sell)$/i; }

async function visible(locator: Locator) { return locator.count().then(async count => count > 0 && locator.first().isVisible().catch(() => false)); }

export async function selectTradeSide(page: Page, side: TradeSide) {
  const switcher = page.locator('[data-sentry-component="Types"]');
  await switcher.first().waitFor({ state: 'visible', timeout: 10_000 }).catch(() => {});
  const tab = switcher.getByText(sidePattern(side));
  await tab.first().waitFor({ state: 'visible', timeout: 5_000 }).catch(() => {});
  if (!await visible(tab)) {
    const fallbackTab = page.locator('[data-sentry-component="Types"] button, [data-sentry-component="Types"] div, div[role="tab"]').filter({ hasText: sidePattern(side) });
    await fallbackTab.first().waitFor({ state: 'visible', timeout: 3_000 }).catch(() => {});
    if (await visible(fallbackTab)) {
      await fallbackTab.first().click();
      await page.waitForTimeout(200);
      return;
    }
    throw new Error(`GMGN ${sideLabel(side)} tab was not found. Panel text: ${JSON.stringify(await switcher.allTextContents())}`);
  }
  await tab.first().click();
  await page.waitForTimeout(200);
}

export async function amountInput(page: Page): Promise<Locator> {
  const switcher = page.locator('[data-sentry-component="Types"]');
  await switcher.first().waitFor({ state: 'visible', timeout: 10_000 }).catch(() => {});
  const input = switcher.locator('xpath=following::input[@role="spinbutton"][1]');
  await input.first().waitFor({ state: 'visible', timeout: 5_000 }).catch(() => {});
  if (await visible(input)) return input.first();
  const fallback = page.locator('input[role="spinbutton"]').first();
  await fallback.waitFor({ state: 'visible', timeout: 3_000 }).catch(() => {});
  if (await visible(fallback)) return fallback;
  throw new Error('GMGN trade amount input was not found.');
}

export async function submitButton(page: Page, side: TradeSide): Promise<Locator> {
  const label = sideLabel(side);
  const colorClass = side === 'buy' ? 'bg-increase' : 'bg-decrease';

  // 1. Direct Anchor: The main submit button is always the full-width action button below the amount input
  try {
    const input = await amountInput(page);
    const followingSubmit = input.locator(`xpath=following::button[contains(@class, "w-full") or contains(@class, "${colorClass}")][1]`);
    await followingSubmit.waitFor({ state: 'visible', timeout: 3_000 }).catch(() => {});
    if (await visible(followingSubmit)) {
      const isTab = await followingSubmit.evaluate(el => Boolean(el.closest('[data-sentry-component="Types"]'))).catch(() => false);
      if (!isTab) return followingSubmit;
    }
  } catch {}

  // 2. Selectors targeting the full-width submit button, strictly excluding the tab switcher
  const candidateLocators = side === 'buy'
    ? [
        page.locator('button[class*="w-full"]:has([data-sentry-component="TradeDisplay"])'),
        page.locator('button[class*="w-full"][class*="bg-increase"]'),
        page.locator('button:has([data-sentry-component="TradeDisplay"])'),
        page.locator('button[class*="!bg-increase-100"]'),
        page.locator('button[class*="w-full"]').filter({ hasText: /(Beli|Buy)/i }),
        page.locator('button').filter({ hasText: /(Beli|Buy)/i }),
      ]
    : [
        page.locator('button[class*="w-full"]:has([data-sentry-component="TradeButtonText"])'),
        page.locator('button[class*="w-full"][class*="bg-decrease"]'),
        page.locator('button:has([data-sentry-component="TradeButtonText"])'),
        page.locator('button[class*="!bg-decrease-100"]'),
        page.locator('button[class*="w-full"]').filter({ hasText: /(Jual|Sell)/i }),
        page.locator('button').filter({ hasText: /(Jual|Sell)/i }),
      ];

  for (const candidate of candidateLocators) {
    const count = await candidate.count().catch(() => 0);
    for (let index = 0; index < count; index++) {
      const el = candidate.nth(index);
      if (await el.isVisible().catch(() => false)) {
        // Crucial: Make 100% sure it is NOT the tab switcher at the top
        const isTab = await el.evaluate(element => Boolean(element.closest('[data-sentry-component="Types"]'))).catch(() => false);
        if (!isTab) return el;
      }
    }
  }
  throw new Error(`GMGN ${label} order submit button was not found.`);
}

export async function clickTradeButton(page: Page, side: TradeSide): Promise<{ clicked: boolean; buttonText: string }> {
  const btn = await submitButton(page, side);
  await btn.waitFor({ state: 'visible', timeout: 5_000 });
  const text = (await btn.textContent())?.trim() ?? '';
  await page.waitForTimeout(200);
  await btn.click({ timeout: 5_000, force: true });
  return { clicked: true, buttonText: text };
}

export async function selectSellPercent(page: Page, percent: number): Promise<void> {
  if (!Number.isInteger(percent) || percent < 1 || percent > 100) {
    throw new Error('--sell-percent must be an integer between 1 and 100.');
  }
  const switcher = page.locator('[data-sentry-component="Types"]');
  await switcher.first().waitFor({ state: 'visible', timeout: 10_000 }).catch(() => {});
  const presets = switcher.locator(`xpath=following::*[normalize-space(.)="${percent}%"]`);
  await presets.first().waitFor({ state: 'visible', timeout: 5_000 }).catch(() => {});
  for (let index = 0; index < await presets.count(); index += 1) {
    const preset = presets.nth(index);
    if (await preset.isVisible().catch(() => false)) {
      await preset.click();
      return;
    }
  }
  throw new Error(`GMGN sell preset ${percent}% was not found.`);
}

export async function applyExecutionSettings(page: Page, settings: ExecutionSettings): Promise<void> {
  const slippage = page.locator('[data-sentry-component="SlippageCustom"] input[role="spinbutton"]');
  if (!await visible(slippage)) {
    const icon = page.locator('svg[data-icon="IconSlippage16pxRegular"]').first();
    const trigger = icon.locator('xpath=ancestor::div[contains(@class,"cursor-pointer")][1]');
    await trigger.waitFor({ state: 'visible', timeout: 5_000 }).catch(() => {});
    if (!await visible(trigger)) throw new Error('GMGN execution-settings expander was not found.');
    await trigger.click();
    await slippage.waitFor({ state: 'visible', timeout: 10_000 });
  }

  const priority = page.locator('[data-sentry-component="PriorityCustomInput"] input[role="spinbutton"]');
  const tip = page.locator('xpath=//span[starts-with(normalize-space(.), "Tip Fee")]/ancestor::div[contains(@class,"justify-between")][1]//input').first();
  const maxAutoPriority = page.locator('input[placeholder="0"]').first();
  const antiMevOff = page.locator('input.pi-radio-button-input[value="off"]').first();
  await priority.waitFor({ state: 'visible', timeout: 5_000 }).catch(() => {});
  if (!await visible(priority) || !await visible(tip) || !await visible(maxAutoPriority) || await antiMevOff.count() === 0) {
    throw new Error('One or more GMGN execution-setting controls were not found.');
  }

  await slippage.fill(String(settings.slippagePercent));
  await priority.fill(String(settings.priorityFeeSol));
  await tip.fill(String(settings.tipFeeSol));
  await maxAutoPriority.fill(String(settings.maxAutoPriorityFeeSol));
  await antiMevOff.locator('xpath=ancestor::label[1]').click();
  await page.waitForTimeout(250);

  const actual = [
    Number(await slippage.inputValue()),
    Number(await priority.inputValue()),
    Number(await tip.inputValue()),
    Number(await maxAutoPriority.inputValue()),
  ];
  if (actual[0] !== settings.slippagePercent || actual[1] !== settings.priorityFeeSol || actual[2] !== settings.tipFeeSol || actual[3] !== settings.maxAutoPriorityFeeSol || !await antiMevOff.isChecked()) {
    throw new Error('GMGN execution settings did not retain the requested values.');
  }
}

export async function inspectTradePanel(
  page: Page,
  side: TradeSide,
  prepared: boolean,
  executionSettingsApplied: boolean,
  extensionsEnabled: boolean,
  conversion: Pick<TradePanelState, 'amountUnit' | 'amountSource' | 'requestedUsdc' | 'requestedSellPercent' | 'solUsdSpot' | 'executionSettings'>,
): Promise<TradePanelState> {
  const input = await amountInput(page);
  let button: Locator | null = null;
  try { button = await submitButton(page, side); } catch { /* GMGN can rerender the order button after amount input. */ }
  const advanced = page.getByText('Adv.', { exact: true });
  return {
    tokenUrl: page.url(),
    side,
    amount: await input.inputValue(),
    ...conversion,
    amountInputFound: true,
    submitButtonFound: button !== null,
    submitDisabled: button ? await button.isDisabled().catch(() => null) : null,
    advancedAvailable: await visible(advanced),
    executionSettingsApplied,
    extensionsEnabled,
    prepared,
    checkedAt: new Date().toISOString(),
  };
}

async function main() {
  const { values } = parseArgs({ options: {
    token: { type: 'string' }, side: { type: 'string', default: 'buy' }, amount: { type: 'string' }, usdc: { type: 'string' }, 'sell-percent': { type: 'string' },
    prepare: { type: 'boolean', default: false }, 'apply-execution-settings': { type: 'boolean', default: false }, 'enable-extensions': { type: 'boolean', default: false }, 'keep-open': { type: 'boolean', default: false }, profileDir: { type: 'string', default: 'profiles/research-aria-tele01' },
    profileName: { type: 'string', default: 'Profile 12' }, output: { type: 'string', default: 'reports/trade-ui-preflight.json' },
  } });
  if (!values.token || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(values.token)) throw new Error('Provide a Solana token mint with --token.');
  if (values.side !== 'buy' && values.side !== 'sell') throw new Error('--side must be buy or sell.');
  const side = values.side as TradeSide;
  const sellPercentValue = values['sell-percent'];
  const sellPercent = sellPercentValue === undefined ? null : Number(sellPercentValue);
  if ([values.amount, values.usdc, sellPercentValue].filter(value => value !== undefined).length > 1) {
    throw new Error('Use exactly one of --amount, --usdc, or --sell-percent.');
  }
  if (!values.amount && !values.usdc && sellPercentValue === undefined) {
    throw new Error('Provide --amount in SOL/token units, --usdc for buy conversion, or --sell-percent for a sell preset.');
  }
  if (side === 'sell' && values.usdc) throw new Error('--usdc is only for buy prefills; sell quantity must use --amount in token units.');
  if (side === 'buy' && sellPercentValue !== undefined) throw new Error('--sell-percent is only available on the sell panel.');
  if (sellPercent !== null && (!Number.isInteger(sellPercent) || sellPercent < 1 || sellPercent > 100)) {
    throw new Error('--sell-percent must be an integer between 1 and 100.');
  }

  const context = await chromium.launchPersistentContext(values.profileDir, {
    channel: 'chrome',
    headless: false,
    viewport: null,
    args: ['--start-maximized', '--profile-directory=' + values.profileName],
    // Kept opt-in: extensions can restore a wallet-backed login, but the
    // script still only prepares UI fields and never submits an order.
    ignoreDefaultArgs: values['enable-extensions'] ? ['--disable-extensions'] : undefined,
  });
  try {
    const page = context.pages()[0] ?? await context.newPage();
    await page.goto('https://gmgn.ai/sol/token/' + values.token, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    await page.locator('[data-sentry-component="Types"]').waitFor({ state: 'visible', timeout: 30_000 });

    let solUsdSpot: number | null = null;
    if (values.usdc) {
      try {
        solUsdSpot = await fetchSolUsdSpot();
      } catch {
        solUsdSpot = await fetchSolUsdSpotInBrowser(page);
      }
    }
    const amount = values.usdc ? usdcToSol(values.usdc, solUsdSpot!) : values.amount ? normalizeAmount(values.amount) : null;
    const conversion = {
      amountUnit: side === 'buy' ? 'SOL' as const : 'token' as const,
      amountSource: sellPercent !== null ? 'sell-percent-preset' as const : side === 'sell' ? 'token-amount' as const : values.usdc ? 'usdc-conversion' as const : 'sol' as const,
      requestedUsdc: values.usdc ? Number(values.usdc) : null,
      requestedSellPercent: sellPercent,
      solUsdSpot,
      executionSettings: { ...DEFAULT_EXECUTION_SETTINGS },
    };
    await selectTradeSide(page, side);
    let executionSettingsApplied = false;
    if (values['apply-execution-settings']) {
      await applyExecutionSettings(page, DEFAULT_EXECUTION_SETTINGS);
      executionSettingsApplied = true;
    }
    let prepared = false;
    if (values.prepare) {
      // This only fills the visible amount field. It deliberately never clicks
      // the GMGN Buy/Sell button and does not submit a transaction.
      if (sellPercent !== null) await selectSellPercent(page, sellPercent);
      else await (await amountInput(page)).fill(amount!);
      prepared = true;
    }
    const report = await inspectTradePanel(page, side, prepared, executionSettingsApplied, values['enable-extensions'], conversion);
    mkdirSync(dirname(values.output), { recursive: true });
    writeFileSync(values.output, JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report));
    if (values['keep-open']) {
      console.log('GMGN window remains open for review. Press Ctrl+C in this terminal to close it.');
      await waitForWindowCloseRequest();
    }
  } finally {
    await context.close();
  }
}

if (process.argv[1]?.endsWith('gmgn-trade-ui.ts')) main().catch(error => { console.error(error); process.exitCode = 1; });
