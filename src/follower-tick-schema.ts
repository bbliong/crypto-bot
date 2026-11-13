export type FollowerChannel = 'token_activity' | 'token_stat' | 'wallet_activity_info';
export interface TickEnvelope {
  schemaVersion: 1;
  sessionId: string;
  connectionId: string;
  requestId: string | null;
  receiveSequence: number;
  itemIndex: number;
  receivedAt: number;
  channel: FollowerChannel;
  mint: string | null;
  source: 'gmgn_browser_ws';
  raw: unknown;
}
export interface CaptureContext {
  sessionId: string;
  connectionId: string;
  requestId: string | null;
  receiveSequence: number;
  receivedAt: number;
  targetWallet: string;
}
