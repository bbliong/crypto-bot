import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { booleanFields, numericFields, type Config } from './model.js';

export function loadConfig(path = 'config/rules.yaml'): Config {
  const c = parse(readFileSync(path, 'utf8')) as Config;
  if (!c || !['observation', 'paper', 'manual'].includes(c.mode)) throw new Error('Invalid mode');
  if (c.phase !== 1 && c.phase !== 2) throw new Error('phase must be 1 or 2');
  if (!Array.isArray(c.mappings)) throw new Error('mappings must be an array');
  for (const key of ['workers', 'queueCapacity', 'workerTimeoutMs', 'activeMonitorSeconds', 'evidenceMaxAgeMs',
    'candidateTtlMs', 'minimumAgeSeconds', 'maximumAgeSeconds', 'minimumHolders', 'minimumLiquidityUsd', 'maximumLiquidityUsd', 'minimumBuys',
    'maximumSellBuyRatio', 'maximumRisePercent', 'maximumDrawdownPercent', 'maximumTop5Percent',
    'maximumTop10Percent', 'maximumSinglePercent', 'maximumBundledPercent', 'maximumSameSlotWallets',
    'maximumSharedFunderWallets', 'maximumClusterPercent', 'maximumDeveloperPercent',
    'maximumDeveloperSoldPercent'] as const) {
    if (!Number.isFinite(c[key]) || c[key] < 0 || (key !== 'minimumAgeSeconds' && c[key] === 0)) throw new Error(`Invalid ${key}`);
  }
  if (!Number.isInteger(c.workers) || c.workers < 1 || c.workers > 8 || !Number.isInteger(c.queueCapacity)) throw new Error('workers: 1..8; queueCapacity: integer');
  if (c.minimumLiquidityUsd > c.maximumLiquidityUsd) throw new Error('minimumLiquidityUsd cannot exceed maximumLiquidityUsd');
  if (c.minimumAgeSeconds > c.maximumAgeSeconds) throw new Error('minimumAgeSeconds cannot exceed maximumAgeSeconds');
  if (c.simulationStakeUsd !== undefined && (!Number.isFinite(c.simulationStakeUsd) || c.simulationStakeUsd <= 0)) throw new Error('Invalid simulationStakeUsd');
  if (c.simulationStakeSol !== undefined && (!Number.isFinite(c.simulationStakeSol) || c.simulationStakeSol <= 0)) throw new Error('Invalid simulationStakeSol');
  if (c.profitStagnationPercent !== undefined && (!Number.isFinite(c.profitStagnationPercent) || c.profitStagnationPercent <= 0)) throw new Error('Invalid profitStagnationPercent');
  if (c.earlyCandleMinimumHolders !== undefined && (!Number.isFinite(c.earlyCandleMinimumHolders) || c.earlyCandleMinimumHolders <= 0)) throw new Error('Invalid earlyCandleMinimumHolders');
  if (c.autoBuy !== undefined && typeof c.autoBuy !== 'boolean') throw new Error('Invalid autoBuy; must be boolean');
  if (c.topHolderDumpMinPercent !== undefined && (!Number.isFinite(c.topHolderDumpMinPercent) || c.topHolderDumpMinPercent <= 0)) throw new Error('Invalid topHolderDumpMinPercent');
  if (typeof c.headless !== 'boolean' || typeof c.browserChannel !== 'string') throw new Error('Invalid browser configuration');
  if (c.browserUserDataDir !== undefined && typeof c.browserUserDataDir !== 'string') throw new Error('Invalid browserUserDataDir');
  if (c.browserProfileDirectory !== undefined && typeof c.browserProfileDirectory !== 'string') throw new Error('Invalid browserProfileDirectory');
  if (c.browserRemoteDebuggingPort !== undefined && (!Number.isInteger(c.browserRemoteDebuggingPort) || c.browserRemoteDebuggingPort < 1024 || c.browserRemoteDebuggingPort > 65535)) throw new Error('Invalid browserRemoteDebuggingPort');
  validateUrl(c.feedUrl, 'gmgn.ai');
  validateTemplate(c.tokenUrlTemplate, 'gmgn.ai');
  if (c.fomoUrlTemplate) validateTemplate(c.fomoUrlTemplate);
  if (c.mode === 'manual' && !c.fomoUrlTemplate) throw new Error('Manual mode requires verified fomoUrlTemplate');
  for (const m of c.mappings) {
    if (!m.channel || !m.mintPath || !m.chainPath || m.chainValue !== 'sol' || typeof m.recordsPath !== 'string') throw new Error('Mapping requires channel, recordsPath, chainPath, chainValue: sol, mintPath');
    if (m.channel === 'chain_stat') throw new Error('Routing channels cannot supply token candidates');
    if (m.channel === 'public_broadcast' && !(m.eventPath === 'et' && m.eventValue === 'signal')) {
      throw new Error('Only the inspected public_broadcast signal event may supply candidates');
    }
    if (!!m.eventPath !== (m.eventValue !== undefined)) throw new Error('eventPath and eventValue must be paired');
    for (const [key, f] of Object.entries(m.fields ?? {})) {
      if (![...numericFields, ...booleanFields].includes(key as never) || !f || typeof f.path !== 'string') throw new Error(`Invalid field mapping ${key}`);
      if (f.scale !== undefined && (!Number.isFinite(f.scale) || f.scale <= 0)) throw new Error('Invalid scale');
      if (f.unit && !['seconds', 'milliseconds'].includes(f.unit)) throw new Error('Invalid timestamp unit');
      if (['createdAt', 'tradingStartedAt'].includes(key) && !f.unit) throw new Error('Timestamp unit must be explicit');
    }
  }
  return c;
}
function validateUrl(value: string, host?: string) {
  const u = new URL(value);
  if (u.protocol !== 'https:' || u.username || u.password || (host && u.hostname !== host)) throw new Error('Invalid HTTPS URL');
}
function validateTemplate(value: string, host?: string) {
  if (!value.includes('{mint}')) throw new Error('Token template requires {mint}');
  validateUrl(value.replaceAll('{mint}', 'mint'), host);
}
