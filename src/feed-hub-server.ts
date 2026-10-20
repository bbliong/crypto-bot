import WebSocket from 'ws';
import type { Transfer } from './distribution-profit4-runtime.js';
import type { TargetTrade } from './distribution-target-lane.js';

export type FeedHubEvent =
  | { type: 'CANDIDATE'; source: string; transfer: Transfer; observedAt: number }
  | { type: 'TRADE_TICK'; mint: string; trade: TargetTrade; observedAt: number }
  | { type: 'HOLDER_FRAME'; mint: string; body: unknown; observedAt: number }
  | { type: 'TRACKED_WALLET_SOLD'; mint: string; wallet: string; source: string; observedAt: number }
  | { type: 'DETAIL_CLOSED'; mint: string; reason: string; observedAt: number };

export type FeedHubCommand =
  | { action: 'SUBSCRIBE_MINT'; mint: string; pool?: string; maxDurationSeconds?: number }
  | { action: 'UNSUBSCRIBE_MINT'; mint: string }
  | { action: 'PING' };

export class FeedHubServer {
  private wss: any = null;
  private clients = new Set<any>();
  private commandHandlers = new Set<(cmd: FeedHubCommand, client: any) => void>();
  private recentCandidates = new Map<string, FeedHubEvent>();

  constructor(public readonly port: number = 8765, public readonly host: string = '127.0.0.1') {}

  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      try {
        this.wss = new WebSocket.Server({ port: this.port, host: this.host });
        this.wss.on('listening', () => {
          console.log(`[feed-hub-server] 🛰️ Hub WebSocket listening on ws://${this.host}:${this.port}`);
          resolve();
        });
        this.wss.on('error', (err: Error) => {
          console.error(`[feed-hub-server] Error:`, err.message);
          reject(err);
        });
        this.wss.on('connection', (ws: any, req: any) => {
          const clientIp = req.socket.remoteAddress;
          this.clients.add(ws);
          console.log(`[feed-hub-server] 🔌 Client connected (${this.clients.size} total) from ${clientIp}`);

          // Replay recent candidates so newly connected/restarted workers immediately catch up
          if (this.recentCandidates.size > 0) {
            for (const cand of this.recentCandidates.values()) {
              try {
                if (ws.readyState === WebSocket.OPEN) {
                  ws.send(JSON.stringify(cand));
                }
              } catch {}
            }
          }

          ws.on('message', (data: Buffer | string) => {
            try {
              const cmd = JSON.parse(data.toString()) as FeedHubCommand;
              if (cmd.action === 'PING') {
                ws.send(JSON.stringify({ type: 'PONG', at: Date.now() }));
                return;
              }
              for (const handler of this.commandHandlers) {
                handler(cmd, ws);
              }
            } catch {}
          });

          ws.on('close', () => {
            this.clients.delete(ws);
            console.log(`[feed-hub-server] 🔌 Client disconnected (${this.clients.size} remaining)`);
          });

          ws.on('error', () => {
            this.clients.delete(ws);
          });
        });
      } catch (err) {
        reject(err);
      }
    });
  }

  onCommand(handler: (cmd: FeedHubCommand, client: any) => void) {
    this.commandHandlers.add(handler);
  }

  broadcast(event: FeedHubEvent) {
    if (event.type === 'CANDIDATE' && (event as any).transfer?.mint) {
      this.recentCandidates.set((event as any).transfer.mint, event);
      if (this.recentCandidates.size > 200) {
        const oldest = this.recentCandidates.keys().next().value;
        if (oldest) this.recentCandidates.delete(oldest);
      }
    }
    if (!this.clients.size) return;
    const payload = JSON.stringify(event);
    for (const ws of this.clients) {
      if (ws.readyState === WebSocket.OPEN) {
        try {
          ws.send(payload);
        } catch {
          this.clients.delete(ws);
        }
      }
    }
  }

  getClientCount(): number {
    return this.clients.size;
  }

  close(): Promise<void> {
    return new Promise((resolve) => {
      if (!this.wss) return resolve();
      this.wss.close(() => resolve());
    });
  }
}
