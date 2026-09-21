import type { Candidate, Check, Config, Field, Report } from './model.js';
export function evaluate(c: Candidate, cfg: Config, now = Date.now(), deep = true): Report {
  const checks: Check[] = [];
  const fresh = (key: Field) => {
    const f = c.fields[key];
    const invalidation = c.invalidatedFields?.[key];
    return f && Number.isFinite(f.observedAt) && f.observedAt > 0 && f.observedAt <= now &&
      (!invalidation || invalidation.observedAt < f.observedAt) &&
      (['createdAt', 'tradingStartedAt'].includes(key) || now - f.observedAt <= cfg.evidenceMaxAgeMs) ? f.value : undefined;
  };
  const num = (key: Field) => {
    const v = fresh(key);
    if (typeof v !== 'number' || !Number.isFinite(v) || (v < 0 && key !== 'risePercent')) return undefined;
    if (key.endsWith('Percent') && key !== 'risePercent' && v > 100) return undefined;
    if (['holders', 'buys', 'sells', 'sameSlotWallets', 'sharedFunderWallets'].includes(key) && !Number.isSafeInteger(v)) return undefined;
    if (['createdAt', 'tradingStartedAt'].includes(key) && v <= 0) return undefined;
    return v;
  };
  const add = (name: string, status: Check['status'], detail: string) => checks.push({ name, status, detail });
  function limit(key: Field, threshold: number, minimum = false, warning = false) {
    const n = num(key);
    add(key, n === undefined ? 'UNKNOWN' : (minimum ? n < threshold : n > threshold) ? (warning ? 'WARN' : 'FAIL') : 'PASS',
      n === undefined ? 'Missing or stale evidence' : `${n}; ${minimum ? 'minimum' : 'maximum'} ${threshold}`);
  }
  function flag(key: Field, expected: boolean) {
    const v = fresh(key);
    add(key, typeof v !== 'boolean' ? 'UNKNOWN' : v === expected ? 'PASS' : 'FAIL',
      typeof v !== 'boolean' ? 'Missing or stale evidence' : `Observed ${v}, expected ${expected}`);
  }
  const created = num('createdAt');
  add('age', created === undefined ? 'UNKNOWN' : now < created || now - created < cfg.minimumAgeSeconds * 1000 || now - created > cfg.maximumAgeSeconds * 1000 ? 'FAIL' : 'PASS',
    created === undefined ? 'No verified creation timestamp; firstSeen is not token age' : `${((now - created) / 1000).toFixed(1)} seconds; range ${cfg.minimumAgeSeconds}–${cfg.maximumAgeSeconds}`);
  limit('holders', cfg.minimumHolders, true);
  const liquidity = num('liquidityUsd');
  add('liquidityUsd', liquidity === undefined ? 'UNKNOWN' : liquidity < cfg.minimumLiquidityUsd || liquidity > cfg.maximumLiquidityUsd ? 'FAIL' : 'PASS',
    liquidity === undefined ? 'Missing or stale evidence' : `${liquidity}; range ${cfg.minimumLiquidityUsd}–${cfg.maximumLiquidityUsd}`);
  limit('buys', cfg.minimumBuys, true);
  const buys = num('buys'), sells = num('sells');
  add('sellBuyRatio', buys === undefined || sells === undefined ? 'UNKNOWN' : buys <= 0 || sells / buys > cfg.maximumSellBuyRatio ? 'FAIL' : 'PASS',
    buys === undefined || sells === undefined ? 'Missing or stale trade counts' : `${sells}/${buys}`);
  // Phase 1 has only fields whose meaning has been verified from the live
  // GMGN stream.  It deliberately does not infer on-chain facts.
  if (cfg.phase === 1) {
    limit('top10Percent', cfg.maximumTop10Percent);
    const currentPrice = num('priceUsd');
    const references = [num('price1mUsd'), num('price5mUsd'), num('price1hUsd')].filter((value): value is number => value !== undefined);
    const peak = currentPrice === undefined ? undefined : Math.max(currentPrice, ...references);
    const drawdown = currentPrice === undefined || peak === undefined || peak <= 0 ? undefined : (peak - currentPrice) / peak * 100;
    add('drawdownPercent', drawdown === undefined ? 'UNKNOWN' : drawdown > cfg.maximumDrawdownPercent ? 'FAIL' : 'PASS',
      drawdown === undefined ? 'Missing current or reference price' : `${drawdown.toFixed(2)}%; maximum ${cfg.maximumDrawdownPercent}`);
  } else {
    limit('risePercent', cfg.maximumRisePercent, false, true);
  }
  if (deep && cfg.phase === 2) {
    limit('drawdownPercent', cfg.maximumDrawdownPercent, false, true);
    flag('mintVerified', true);
    flag('holdersComplete', true); flag('ownersResolved', true);
    limit('top5Percent', cfg.maximumTop5Percent); limit('top10Percent', cfg.maximumTop10Percent); limit('singlePercent', cfg.maximumSinglePercent);
    flag('bundlingComplete', true);
    limit('bundledPercent', cfg.maximumBundledPercent);
    limit('sameSlotWallets', cfg.maximumSameSlotWallets, false, true);
    limit('sharedFunderWallets', cfg.maximumSharedFunderWallets, false, true);
    flag('walletMapComplete', true); flag('developerLinkedCluster', false);
    limit('largestClusterPercent', cfg.maximumClusterPercent);
    flag('developerComplete', true);
    limit('developerPercent', cfg.maximumDeveloperPercent); limit('developerSoldPercent', cfg.maximumDeveloperSoldPercent);
    flag('mintAuthorityActive', false); flag('freezeAuthorityActive', false);
    flag('lpVerified', true); flag('lpWithdrawable', false);
    flag('tokenExtensionsVerified', true); flag('transferHookActive', false); limit('transferFeePercent', 0);
  }
  const warns = checks.filter(x => x.status === 'WARN').length;
  const status = checks.some(x => x.status === 'FAIL') || warns >= 2 ? 'REJECT'
    : checks.some(x => x.status === 'UNKNOWN') ? 'INSUFFICIENT_EVIDENCE' : warns ? 'WATCH' : 'ENTRY_READY';
  return { mint: c.mint, firstSeenAt: c.firstSeenAt, signalAt: now, mode: cfg.mode, status, checks, fields: structuredClone(c.fields) };
}
