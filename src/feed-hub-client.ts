import { EventEmitter } from 'node:events';
import WebSocket from 'ws';
import type { FeedHubEvent, FeedHubCommand } from './feed-hub-server.js';

export class FeedHubClient extends EventEmitter {
  private ws: any = null;
  private shouldReconnect: boolean = true;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private isConnecting: boolean = false;

  constructor(
    public readonly url: string = 'ws://127.0.0.1:8765',
    private readonly name: string = 'worker'
  ) {
    super();
  }

  connect() {
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
      return;
    }
    this.isConnecting = true;
    try {
      this.ws = new WebSocket(this.url);

      this.ws.on('open', () => {
        this.isConnecting = false;
        console.log(`[${this.name}] 🚀 Connected to Feed Hub at ${this.url}`);
        this.emit('connected');
      });

      this.ws.on('message', (data: Buffer | string) => {
        try {
          const event = JSON.parse(data.toString()) as FeedHubEvent;
          switch (event.type) {
            case 'CANDIDATE':
              this.emit('candidate', event);
              break;
            case 'TRADE_TICK':
              this.emit('trade', event);
              break;
            case 'HOLDER_FRAME':
              this.emit('holderFrame', event);
              break;
            case 'TRACKED_WALLET_SOLD':
              this.emit('walletSold', event);
              break;
            case 'DETAIL_CLOSED':
              this.emit('detailClosed', event);
              break;
            default:
              this.emit('event', event);
          }
        } catch (err: any) {
          console.warn(`[${this.name}] Failed to parse message:`, err.message);
        }
      });

      this.ws.on('close', () => {
        this.isConnecting = false;
        this.emit('disconnected');
        this.scheduleReconnect();
      });

      this.ws.on('error', (err: Error) => {
        this.isConnecting = false;
        console.warn(`[${this.name}] Hub socket error (${err.message}). Retrying...`);
        this.emit('error', err);
        this.ws?.close?.();
      });
    } catch (err: any) {
      this.isConnecting = false;
      this.scheduleReconnect();
    }
  }

  private scheduleReconnect() {
    if (!this.shouldReconnect || this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      console.log(`[${this.name}] 🔄 Reconnecting to Feed Hub...`);
      this.connect();
    }, 2000);
  }

  sendCommand(cmd: FeedHubCommand) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      try {
        this.ws.send(JSON.stringify(cmd));
      } catch {}
    }
  }

  subscribeMint(mint: string, pool?: string, maxDurationSeconds?: number) {
    this.sendCommand({ action: 'SUBSCRIBE_MINT', mint, pool, maxDurationSeconds });
  }

  unsubscribeMint(mint: string) {
    this.sendCommand({ action: 'UNSUBSCRIBE_MINT', mint });
  }

  close() {
    this.shouldReconnect = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }
}
