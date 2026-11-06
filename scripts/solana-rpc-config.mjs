import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const defaultRoot = fileURLToPath(new URL('../', import.meta.url));

export function getSolanaRpcUrl(root = defaultRoot) {
  let rpcUrl = process.env.SOLANA_RPC_URL || '';
  let heliusKey = process.env.HELIUS_API_KEY || '';
  try {
    const envPath = join(root, '.env');
    if (existsSync(envPath)) {
      const content = readFileSync(envPath, 'utf8');
      const rpcMatch = content.match(/SOLANA_RPC_URL=([^\s\r\n]+)/);
      if (rpcMatch && rpcMatch[1]) {
        rpcUrl = rpcMatch[1].trim();
      }
      const keyMatch = content.match(/HELIUS_API_KEY=([^\s\r\n]+)/);
      if (keyMatch) heliusKey = keyMatch[1].trim();
    }
  } catch {}

  if (rpcUrl && !rpcUrl.includes('helius-rpc.com')) {
    return rpcUrl;
  }
  if (heliusKey && !rpcUrl.includes('api.mainnet-beta.solana.com')) {
    return `https://mainnet.helius-rpc.com/?api-key=${heliusKey}`;
  }
  return rpcUrl || 'https://api.mainnet-beta.solana.com';
}

export function getSolanaRpcWsUrl(root = defaultRoot) {
  let wsUrl = process.env.SOLANA_RPC_WS_URL || '';
  let heliusKey = process.env.HELIUS_API_KEY || '';
  try {
    const envPath = join(root, '.env');
    if (existsSync(envPath)) {
      const content = readFileSync(envPath, 'utf8');
      const wsMatch = content.match(/SOLANA_RPC_WS_URL=([^\s\r\n]+)/);
      if (wsMatch && wsMatch[1]) {
        wsUrl = wsMatch[1].trim();
      }
      const keyMatch = content.match(/HELIUS_API_KEY=([^\s\r\n]+)/);
      if (keyMatch) heliusKey = keyMatch[1].trim();
    }
  } catch {}

  if (wsUrl && !wsUrl.includes('helius-rpc.com')) {
    return wsUrl;
  }
  if (heliusKey && !wsUrl.includes('api.mainnet-beta.solana.com')) {
    return `wss://mainnet.helius-rpc.com/?api-key=${heliusKey}`;
  }
  return wsUrl || 'wss://api.mainnet-beta.solana.com';
}
