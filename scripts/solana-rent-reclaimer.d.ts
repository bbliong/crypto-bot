import { Connection, Keypair, PublicKey } from '@solana/web3.js';

export interface EmptyTokenAccount {
  pubkey: string;
  mint: string;
  program: string;
  programId: string;
  tokenAmount: string;
  uiAmount: number;
  lamports: number;
  rentSol: number;
}

export interface ScanResult {
  wallet: string;
  emptyAccounts: EmptyTokenAccount[];
  activeAccounts: EmptyTokenAccount[];
  emptyCount: number;
  activeCount: number;
  totalReclaimableSol: number;
  totalReclaimableLamports: number;
}

export interface ReclaimResult {
  ok: boolean;
  message?: string;
  reclaimedCount: number;
  reclaimedSol: number;
  signatures?: string[];
  urls?: string[];
  details?: any[];
}

export function loadEnv(): void;
export function getKeypair(): Keypair | null;
export function scanEmptyTokenAccounts(connection: Connection, walletAddress?: string | PublicKey): Promise<ScanResult>;
export function reclaimRentForMint(mintAddress: string, options?: { keypair?: Keypair | null; rpcUrl?: string }): Promise<ReclaimResult>;
export function reclaimAllEmptyAccounts(options?: { keypair?: Keypair | null; rpcUrl?: string }): Promise<ReclaimResult>;
