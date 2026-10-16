import { readFileSync } from 'node:fs';

// Let us inspect the trade history of tokens that traversed 0.000300 - 0.000800
const cache = JSON.parse(readFileSync('/home/bbliong/project/crypto-bot/data/profit4-watch/tx-cluster-cache.json', 'utf8'));

console.log('Total airdrop tx in cache:', Object.keys(cache).length);
