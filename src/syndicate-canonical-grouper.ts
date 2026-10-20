import fs from 'node:fs';
import path from 'node:path';

export interface MintDetail {
  mint: string;
  name?: string;
  symbol?: string;
  wallets: number;
  ts: number;
  timeWib: string;
  sampleWallet?: string | null;
  deployer?: string | null;
  fdv?: number;
}

export interface CanonicalGroup {
  rank: number;
  displayName: string;
  totalWallets: number;
  mintsCount: number;
  latestMint: string;
  latestTransferAt: number;
  latestTransferWib: string;
  sampleWallet: string | null;
  deployerAddress: string | null;
  isWatched: boolean;
  mintDetails: MintDetail[];
}

export interface MonitoredTarget {
  tokenName: string;
  tokenMint: string;
  symbol: string;
  totalSyndicateWallets: number;
  latestTransferWib: string;
  monitoredWallet: string;
  deployerAddress: string;
}

export function parseWibTimestamp(timeWibStr: string): number {
  try {
    // Expected format: "2026-10-19 22:26:08 WIB" or "19/10/2026, 22.26.08 WIB"
    const cleaned = timeWibStr.replace(' WIB', '').trim();
    if (cleaned.includes('-')) {
      const [datePart, timePart] = cleaned.split(' ');
      const [y, m, d] = datePart.split('-').map(Number);
      const [h, min, s] = timePart.split(':').map(Number);
      return Math.floor(Date.UTC(y, m - 1, d, h - 7, min, s) / 1000);
    } else if (cleaned.includes('/')) {
      const [datePart, timePart] = cleaned.split(',').map(s => s.trim());
      const [d, m, y] = datePart.split('/').map(Number);
      const [h, min, s] = timePart.split('.').map(Number);
      return Math.floor(Date.UTC(y, m - 1, d, h - 7, min, s) / 1000);
    }
  } catch {}
  return 0;
}

export function getCanonicalName(rawName = '', sym = ''): string {
  const n = (rawName || '').toLowerCase();
  const s = (sym || '').toLowerCase();

  if (n.includes('gemini') || s.includes('gemini')) return 'Google Gemini';
  if (n.includes('nvidia') || s.includes('nvidia')) return 'NVIDIA SSI';
  if (s.includes('barron2044') || n.includes('barron2044')) return 'BARRON2044';
  if (s.includes('barron') || n.includes('barron')) return 'BARRON';
  if (s.includes('fomo') || n.includes('fomo')) return 'FOMO';
  if (n.includes('claude') || s.includes('claude')) return 'Claude AI';
  if (n.includes('chatgpt') || n.includes('openai') || s.includes('chatgpt') || s.includes('openai')) return 'OpenAI / ChatGPT';
  if (n.includes('deepseek') || s.includes('deepseek')) return 'DeepSeek';
  if (s.includes('speed') || n.includes('speed')) return 'Speed';
  if (n.includes('anthropic') || s.includes('anthropic')) return 'Anthropic';
  if (n.includes('tiktok') || s.includes('tiktok')) return 'TikTok US';
  if (n.includes('apple') || s.includes('apple')) return 'Apple';
  if (n.includes('haaland') || s.includes('haaland')) return 'Haaland';
  if (n.includes('elon') || s.includes('elon')) return 'ELON';
  if (n.includes('coca cola') || s.includes('cola')) return 'Coca Cola';
  if (n.includes('gta') || s.includes('gta')) return 'GTA 6 Coin';
  if (n.includes('taylor') || s.includes('taylor')) return 'Taylor Swift';
  if (n.includes('mr beast') || s.includes('mr beast')) return 'Mr Beast';
  if (n.includes('samsung') || s.includes('samsung')) return 'Samsung';
  if (n.includes('tesla') || s.includes('tesla')) return 'TESLA SI';
  if (n.includes('grok') || s.includes('grok')) return 'Grok';
  if (n.includes('starbucks') || s.includes('starbucks')) return 'STARBUCKS';
  if (n.includes('spacex') || s.includes('spacex')) return 'SpaceX';
  if (n.includes('natgeo') || s.includes('natgeo')) return 'NatGeo';
  if (n.includes('naruto') || s.includes('naruto')) return 'Naruto';
  if (n.includes('mcdonald') || s.includes('mcd')) return "McDonald's";
  if (n.includes('pikachu') || s.includes('pokemon')) return 'Pikachu / Pokemon';
  if (n.includes('van cleef') || s.includes('van cleef')) return 'Van Cleef';
  if (n.includes('simpson') || s.includes('simpson')) return 'The Simpsons';
  if (n.includes('dragonball') || s.includes('dragonball')) return 'DragonBall';
  if (n.includes('trala') || s.includes('trala')) return 'TRALA';
  if (n.includes('harry potter') || s.includes('harypotter')) return 'Harry Potter';
  if (n.includes('trump') || s.includes('trump')) return 'Trump $1 Coin';
  if (n.includes('coinbase') || s.includes('coinbase')) return 'Coinbase';
  if (n.includes('hood') || s.includes('robinhood')) return 'Robinhood (HOOD)';
  if (n.includes('100x') || s.includes('1 to 100x')) return '100X Meme';
  if (n.includes('pump') || s.includes('pump')) return 'Pump (PUMP)';
  if (n.includes('muse') || s.includes('muse')) return 'Muse AI';
  if (n.includes('oezank') || s.includes('baguette')) return 'OEZANK / Baguette';
  if (n.includes('marsx') || s.includes('marsx')) return 'MarsX';
  if (n.includes('pyusd') || s.includes('pyusd')) return 'PayPal USD (PYUSD)';
  if (n.includes('smart') || s.includes('usd1')) return 'SMART / USD1';
  if (n.includes('stardust')) return 'Stardust (SMART)';
  if (s.includes('ttwo') || n.includes('take-two')) return 'Take-Two (TTWO)';
  if (n.includes('hulk') || s.includes('hulked')) return 'HULKED';

  return rawName || sym || 'Sindikat Meme Token';
}

export function buildCanonicalSyndicateGroups(rootDir = '/home/bbliong/project/crypto-bot'): CanonicalGroup[] {
  const transFile = path.join(rootDir, 'data', 'syndicate-watch', 'syndicate-latest-transfers-by-token.json');
  if (!fs.existsSync(transFile)) {
    return [];
  }

  const raw = JSON.parse(fs.readFileSync(transFile, 'utf8'));
  const tokens = raw.tokens || [];

  const groupsMap = new Map<string, {
    displayName: string;
    totalWallets: number;
    mints: Set<string>;
    latestTs: number;
    latestMint: string;
    latestTimeWib: string;
    latestSampleWallet: string | null;
    latestDeployer: string | null;
    mintDetails: MintDetail[];
  }>();

  for (const t of tokens) {
    const dname = getCanonicalName(t.name, t.symbol);
    if (!groupsMap.has(dname)) {
      groupsMap.set(dname, {
        displayName: dname,
        totalWallets: 0,
        mints: new Set(),
        latestTs: 0,
        latestMint: t.mint,
        latestTimeWib: t.latestTransferTimeWib,
        latestSampleWallet: (t.sampleWallets && t.sampleWallets[0]) || null,
        latestDeployer: t.deployer || null,
        mintDetails: []
      });
    }

    const g = groupsMap.get(dname)!;
    g.totalWallets += (t.walletsCount || 0);
    g.mints.add(t.mint);

    const ts = parseWibTimestamp(t.latestTransferTimeWib);
    const sampleWallet = (t.sampleWallets && t.sampleWallets[0]) || null;
    const deployer = t.deployer || null;

    g.mintDetails.push({
      mint: t.mint,
      name: t.name,
      symbol: t.symbol,
      wallets: t.walletsCount,
      ts,
      timeWib: t.latestTransferTimeWib,
      sampleWallet,
      deployer,
      fdv: t.fdv
    });

    if (ts > g.latestTs) {
      g.latestTs = ts;
      g.latestMint = t.mint;
      g.latestTimeWib = t.latestTransferTimeWib;
      if (sampleWallet) {
        g.latestSampleWallet = sampleWallet;
      }
      if (deployer) {
        g.latestDeployer = deployer;
      }
    }
  }

  // Sort descending by recency
  const sorted = Array.from(groupsMap.values()).sort((a, b) => b.latestTs - a.latestTs);

  // Top 5 with totalWallets >= 10 are watching targets
  const eligibleWatched = sorted.filter(g => g.totalWallets >= 10).slice(0, 5);
  const watchedNames = new Set(eligibleWatched.map(g => g.displayName));

  return sorted.map((g, idx) => ({
    rank: idx + 1,
    displayName: g.displayName,
    totalWallets: g.totalWallets,
    mintsCount: g.mints.size,
    latestMint: g.latestMint,
    latestTransferAt: g.latestTs,
    latestTransferWib: g.latestTimeWib,
    sampleWallet: g.latestSampleWallet,
    deployerAddress: g.latestDeployer,
    isWatched: watchedNames.has(g.displayName),
    mintDetails: g.mintDetails
  }));
}

export function selectTopSyndicateWatchingTargets(rootDir = '/home/bbliong/project/crypto-bot', minWallets = 10, limit = 5): MonitoredTarget[] {
  // If verified targets already exist with explicit GMGN validation, preserve them
  const monitoredWalletsFile = path.join(rootDir, 'data', 'syndicate-watch', 'gmgn-monitored-wallets.json');
  if (fs.existsSync(monitoredWalletsFile)) {
    try {
      const existing = JSON.parse(fs.readFileSync(monitoredWalletsFile, 'utf8'));
      if (Array.isArray(existing.targets) && existing.targets.length >= limit && existing.targets.some((t: any) => t.gmgnLatestActivity)) {
        return existing.targets.slice(0, limit);
      }
    } catch {}
  }

  const groups = buildCanonicalSyndicateGroups(rootDir);
  const eligible = groups.filter(g => g.totalWallets >= minWallets);
  const topGroups = eligible.slice(0, limit);

  // Attempt to select exclusive recipient wallets from SQLite where token is strictly latest
  const usedWallets = new Set<string>();
  const dbPath = path.join(rootDir, 'data', 'crypto-bot.sqlite');
  let db: any = null;
  try {
    if (fs.existsSync(dbPath)) {
      const { DatabaseSync } = require('node:sqlite');
      db = new DatabaseSync(dbPath);
    }
  } catch {}

  return topGroups.map(g => {
    let chosenWallet = g.sampleWallet;
    if (db) {
      try {
        const rows = db.prepare(`
          WITH ranked AS (
            SELECT 
              to_address,
              mint,
              block_time,
              ROW_NUMBER() OVER(PARTITION BY to_address ORDER BY block_time DESC) as rn
            FROM syndicate_transfers
            WHERE mint NOT IN (
              'So11111111111111111111111111111111111111112',
              'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
              'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB'
            )
          )
          SELECT to_address
          FROM ranked
          WHERE rn = 1 AND mint = ?
          LIMIT 10
        `).all(g.latestMint);

        for (const r of rows) {
          if (!usedWallets.has(r.to_address)) {
            chosenWallet = r.to_address;
            usedWallets.add(r.to_address);
            break;
          }
        }
      } catch {}
    }

    if (chosenWallet) {
      usedWallets.add(chosenWallet);
    }

    return {
      tokenName: g.displayName,
      tokenMint: g.latestMint,
      symbol: g.displayName.split(' ')[0] || 'MEME',
      totalSyndicateWallets: g.totalWallets,
      latestTransferWib: g.latestTransferWib,
      monitoredWallet: chosenWallet || 'D98kYXmPnSZJeqacgf4Da5GBwFAH8uH8yhhGpagYuVna',
      deployerAddress: g.deployerAddress || 'DHZYnMyqknLmJkrwySqQqiJ7qrNZSGg5Nw4AXLZYN2Hz'
    };
  });
}

export function syncCanonicalSyndicateOutputs(rootDir = '/home/bbliong/project/crypto-bot') {
  const groups = buildCanonicalSyndicateGroups(rootDir);
  const targets = selectTopSyndicateWatchingTargets(rootDir, 10, 5);

  const syndicateWatchDir = path.join(rootDir, 'data', 'syndicate-watch');
  const profit4WatchDir = path.join(rootDir, 'data', 'profit4-watch');
  fs.mkdirSync(syndicateWatchDir, { recursive: true });
  fs.mkdirSync(profit4WatchDir, { recursive: true });

  // 1. Export canonical groups JSON
  const canonicalFile = path.join(syndicateWatchDir, 'canonical-syndicate-tokens.json');
  fs.writeFileSync(canonicalFile, JSON.stringify({
    updatedAt: new Date().toISOString(),
    totalCanonicalGroups: groups.length,
    groups
  }, null, 2), 'utf8');

  // 2. Export monitored wallets JSON
  const monitoredWalletsFile = path.join(syndicateWatchDir, 'gmgn-monitored-wallets.json');
  fs.writeFileSync(monitoredWalletsFile, JSON.stringify({
    updatedAt: new Date().toISOString(),
    selectionRule: 'Top 5 newest unique canonical syndicate groups with >=10 wallets, 1 wallet per syndicate',
    watchingTargetsCount: targets.length,
    targets
  }, null, 2), 'utf8');

  // 3. Sync to dashboard config and worker control
  const dashboardConfigFile = path.join(profit4WatchDir, 'dashboard-config.json');
  const feedHubConfigFile = path.join(rootDir, 'data', 'feed-hub', 'dashboard-config.json');
  const addresses = targets.map(t => t.monitoredWallet);
  fs.writeFileSync(dashboardConfigFile, JSON.stringify({ addresses }, null, 2), 'utf8');
  try {
    fs.mkdirSync(path.join(rootDir, 'data', 'feed-hub'), { recursive: true });
    fs.writeFileSync(feedHubConfigFile, JSON.stringify({ addresses }, null, 2), 'utf8');
  } catch {}

  const workerControlFile = path.join(profit4WatchDir, 'worker-control.json');
  if (fs.existsSync(workerControlFile)) {
    try {
      const wc = JSON.parse(fs.readFileSync(workerControlFile, 'utf8'));
      wc.addresses = addresses;
      fs.writeFileSync(workerControlFile, JSON.stringify(wc, null, 2), 'utf8');
    } catch {}
  }

  return { groups, targets };
}

// CLI runner
if (process.argv[1] && process.argv[1].endsWith('syndicate-canonical-grouper.ts')) {
  const { groups, targets } = syncCanonicalSyndicateOutputs();
  console.log(`✅ Synced ${groups.length} canonical groups and ${targets.length} watching targets.`);
  targets.forEach((t, i) => {
    console.log(`   ${i + 1}. [${t.tokenName}] Wallets: ${t.totalSyndicateWallets} | Mint: ${t.tokenMint} | Monitored: ${t.monitoredWallet}`);
  });
}
