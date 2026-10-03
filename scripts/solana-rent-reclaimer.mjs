#!/usr/bin/env node
import { Connection, Keypair, PublicKey, Transaction } from '@solana/web3.js';
import { createCloseAccountInstruction, TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } from '@solana/spl-token';
import bs58 from 'bs58';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const projectRoot = join(__dirname, '..');

// Load .env if present
export function loadEnv() {
  const envPath = join(projectRoot, '.env');
  if (existsSync(envPath)) {
    const lines = readFileSync(envPath, 'utf8').split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const idx = trimmed.indexOf('=');
      if (idx > 0) {
        const key = trimmed.slice(0, idx).trim();
        let val = trimmed.slice(idx + 1).trim();
        if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
          val = val.slice(1, -1);
        }
        if (!process.env[key]) process.env[key] = val;
      }
    }
  }
}

loadEnv();

const DEFAULT_RPC = process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com';
const WALLET_ADDRESS = process.env.SOLANA_WALLET_ADDRESS || 'F2yWctiAKCa3EDCsXUgTQfHd1r3u5VpaWsDymkDGxqt6';

/**
 * Mendapatkan Keypair wallet dari environment variable atau config.
 * Mendukung format Base58 string (export GMGN / Phantom) atau byte array JSON.
 */
export function getKeypair() {
  const rawKey = process.env.SOLANA_PRIVATE_KEY || process.env.WALLET_SECRET_KEY;
  if (!rawKey) return null;

  try {
    const trimmed = rawKey.trim();
    if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
      const arr = JSON.parse(trimmed);
      return Keypair.fromSecretKey(Uint8Array.from(arr));
    }
    return Keypair.fromSecretKey(bs58.decode(trimmed));
  } catch (err) {
    console.error('❌ Gagal mem-parse private key:', err.message);
    return null;
  }
}

/**
 * Scan seluruh token account milik wallet (baik SPL standard maupun Token-2022).
 * Mengembalikan daftar akun yang saldonya 0 dan siap di-close untuk reclaim rent SOL.
 */
export async function scanEmptyTokenAccounts(connection, walletAddress = WALLET_ADDRESS) {
  const walletPubkey = typeof walletAddress === 'string' ? new PublicKey(walletAddress) : walletAddress;
  const programs = [
    { name: 'Token-2022', id: TOKEN_2022_PROGRAM_ID },
    { name: 'SPL-Token', id: TOKEN_PROGRAM_ID }
  ];

  const emptyAccounts = [];
  const activeAccounts = [];

  for (const prog of programs) {
    try {
      const response = await connection.getParsedTokenAccountsByOwner(walletPubkey, {
        programId: prog.id
      }, 'confirmed');

      for (const item of response.value) {
        const info = item.account.data.parsed.info;
        const amount = info.tokenAmount?.amount ?? '0';
        const uiAmount = info.tokenAmount?.uiAmount ?? 0;
        const lamports = item.account.lamports;
        const rentSol = lamports / 1e9;

        const record = {
          pubkey: item.pubkey.toBase58(),
          mint: info.mint,
          program: prog.name,
          programId: prog.id.toBase58(),
          tokenAmount: amount,
          uiAmount,
          lamports,
          rentSol
        };

        if (amount === '0' || uiAmount === 0) {
          emptyAccounts.push(record);
        } else {
          activeAccounts.push(record);
        }
      }
    } catch (e) {
      console.warn(`[scan-accounts] Error querying ${prog.name}:`, e.message);
    }
  }

  const totalReclaimableSol = emptyAccounts.reduce((sum, a) => sum + a.rentSol, 0);

  return {
    wallet: walletPubkey.toBase58(),
    emptyAccounts,
    activeAccounts,
    emptyCount: emptyAccounts.length,
    activeCount: activeAccounts.length,
    totalReclaimableSol,
    totalReclaimableLamports: emptyAccounts.reduce((sum, a) => sum + a.lamports, 0)
  };
}

/**
 * Reclaim rent untuk token mint tertentu (biasanya dipanggil sesaat setelah Sell selesai).
 */
export async function reclaimRentForMint(mintAddress, options = {}) {
  const keypair = options.keypair || getKeypair();
  if (!keypair) {
    return { ok: false, message: 'SOLANA_PRIVATE_KEY tidak ditemukan di environment (.env).' };
  }

  const rpcUrl = options.rpcUrl || DEFAULT_RPC;
  const connection = new Connection(rpcUrl, 'confirmed');
  const walletPubkey = keypair.publicKey;

  console.log(`[reclaim-rent] Memeriksa akun kosong untuk mint: ${mintAddress}...`);
  const scan = await scanEmptyTokenAccounts(connection, walletPubkey);
  const targetAccounts = scan.emptyAccounts.filter(a => a.mint === mintAddress);

  if (targetAccounts.length === 0) {
    return { ok: true, reclaimedCount: 0, reclaimedSol: 0, message: 'Tidak ada akun kosong yang ditemukan untuk mint ini (mungkin saldo belum 0 atau sudah di-close).' };
  }

  return closeAccountsBatch(connection, keypair, targetAccounts);
}

/**
 * Reclaim semua token account yang kosong sekaligus (dibatasi batch 15 akun per transaksi).
 */
export async function reclaimAllEmptyAccounts(options = {}) {
  const keypair = options.keypair || getKeypair();
  if (!keypair) {
    return { ok: false, message: 'SOLANA_PRIVATE_KEY tidak ditemukan di environment (.env).' };
  }

  const rpcUrl = options.rpcUrl || DEFAULT_RPC;
  const connection = new Connection(rpcUrl, 'confirmed');
  const walletPubkey = keypair.publicKey;

  const scan = await scanEmptyTokenAccounts(connection, walletPubkey);
  if (scan.emptyCount === 0) {
    return { ok: true, reclaimedCount: 0, reclaimedSol: 0, message: 'Semua akun token bersih. Tidak ada rent yang dapat ditarik.' };
  }

  console.log(`[reclaim-all] Menemukan ${scan.emptyCount} akun kosong (~${scan.totalReclaimableSol.toFixed(6)} SOL). Menjalankan penutupan...`);
  return closeAccountsBatch(connection, keypair, scan.emptyAccounts);
}

/**
 * Menutup daftar akun kosong dalam batch transaksi.
 */
async function closeAccountsBatch(connection, keypair, accounts, batchSize = 12) {
  const walletPubkey = keypair.publicKey;
  const results = [];
  let totalReclaimedLamports = 0;

  for (let i = 0; i < accounts.length; i += batchSize) {
    const chunk = accounts.slice(i, i + batchSize);
    const tx = new Transaction();

    for (const acc of chunk) {
      const accPubkey = new PublicKey(acc.pubkey);
      const progId = new PublicKey(acc.programId);
      const ix = createCloseAccountInstruction(
        accPubkey,
        walletPubkey,
        walletPubkey,
        [],
        progId
      );
      tx.add(ix);
      totalReclaimedLamports += acc.lamports;
    }

    try {
      const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
      tx.recentBlockhash = blockhash;
      tx.feePayer = walletPubkey;
      tx.sign(keypair);

      const rawTx = tx.serialize();
      const sig = await connection.sendRawTransaction(rawTx, {
        skipPreflight: false,
        preflightCommitment: 'confirmed'
      });

      console.log(`  🚀 Transaksi Reclaim Rent terkirim! Sig: ${sig}`);
      const confirmation = await connection.confirmTransaction({
        signature: sig,
        blockhash,
        lastValidBlockHeight
      }, 'confirmed');

      if (confirmation.value.err) {
        results.push({ ok: false, sig, error: confirmation.value.err, count: chunk.length });
      } else {
        results.push({ ok: true, sig, count: chunk.length, url: `https://solscan.io/tx/${sig}` });
      }
    } catch (err) {
      console.error(`  ❌ Gagal memproses batch reclaim:`, err.message);
      results.push({ ok: false, error: err.message, count: chunk.length });
    }
  }

  const successCount = results.filter(r => r.ok).reduce((sum, r) => sum + r.count, 0);
  const reclaimedSol = (totalReclaimedLamports / 1e9);

  return {
    ok: successCount > 0,
    reclaimedCount: successCount,
    reclaimedSol,
    signatures: results.filter(r => r.ok).map(r => r.sig),
    urls: results.filter(r => r.ok).map(r => r.url),
    details: results
  };
}

// CLI Execution
if (process.argv[1] && process.argv[1].endsWith('solana-rent-reclaimer.mjs')) {
  async function runCli() {
    const args = process.argv.slice(2);
    const isScanOnly = args.includes('--scan') || (!args.includes('--reclaim') && !args.includes('--mint'));
    const isReclaimAll = args.includes('--reclaim');
    const mintIdx = args.indexOf('--mint');
    const targetMint = mintIdx !== -1 ? args[mintIdx + 1] : null;

    console.log('='.repeat(70));
    console.log('       🛡️  SOLANA TOKEN RENT RECLAIMER & CLEANUP UTILITY');
    console.log('='.repeat(70));
    console.log(` Target Wallet : ${WALLET_ADDRESS}`);
    console.log(` RPC Endpoint  : ${DEFAULT_RPC}`);

    const keypair = getKeypair();
    console.log(` Private Key   : ${keypair ? '✅ Dikonfigurasi (Siap Reclaim Otomatis)' : '⚠️ Belum dikonfigurasi di .env'}`);
    console.log('='.repeat(70) + '\n');

    const connection = new Connection(DEFAULT_RPC, 'confirmed');

    if (isScanOnly) {
      console.log('🔍 Memindai seluruh token account...');
      const scan = await scanEmptyTokenAccounts(connection, WALLET_ADDRESS);

      console.log(`\n📊 HASIL SCAN:`);
      console.log(`- Total Akun Aktif (Ada Saldo) : ${scan.activeCount}`);
      console.log(`- Total Akun Kosong (0 Saldo)   : ${scan.emptyCount}`);
      console.log(`- Total SOL Tersandera (Rent)   : ${scan.totalReclaimableSol.toFixed(6)} SOL (~$${(scan.totalReclaimableSol * 117.7).toFixed(2)})\n`);

      if (scan.emptyCount > 0) {
        console.log('📋 Daftar Akun Kosong yang Dapat Di-Reclaim:');
        scan.emptyAccounts.forEach((acc, i) => {
          console.log(`  [${i + 1}] ATA: ${acc.pubkey}`);
          console.log(`      Program : ${acc.program}`);
          console.log(`      Mint    : ${acc.mint}`);
          console.log(`      Rent    : ${acc.rentSol.toFixed(6)} SOL (${acc.lamports} lamports)`);
        });

        console.log('\n💡 Untuk me-reclaim saldo ini:');
        if (!keypair) {
          console.log('   1. Masukkan SOLANA_PRIVATE_KEY ke file .env di root project');
          console.log('   2. Jalankan: node scripts/solana-rent-reclaimer.mjs --reclaim');
        } else {
          console.log('   Jalankan: node scripts/solana-rent-reclaimer.mjs --reclaim');
        }
      }
    } else if (targetMint) {
      if (!keypair) {
        console.error('❌ Memerlukan SOLANA_PRIVATE_KEY di .env untuk eksekusi on-chain.');
        process.exit(1);
      }
      console.log(`⚡ Me-reclaim rent untuk mint: ${targetMint}...`);
      const res = await reclaimRentForMint(targetMint, { connection, keypair });
      console.log(res);
    } else if (isReclaimAll) {
      if (!keypair) {
        console.error('❌ Memerlukan SOLANA_PRIVATE_KEY di .env untuk eksekusi on-chain.');
        process.exit(1);
      }
      console.log('⚡ Me-reclaim SEMUA rent akun kosong...');
      const res = await reclaimAllEmptyAccounts({ connection, keypair });
      console.log(res);
    }
  }

  runCli().catch(err => {
    console.error('Fatal CLI error:', err);
    process.exit(1);
  });
}
