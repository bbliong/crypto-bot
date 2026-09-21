import type { Page } from 'playwright';
import { decodeFrame, describeFrame } from './parser.js';
export interface CaptureEvent {
  kind: 'open' | 'close' | 'error' | 'frame' | 'invalid'; source: string;
  direction?: 'received' | 'sent'; observedAt: number;
  schema?: ReturnType<typeof describeFrame>;
}
export function isGmgnSocket(url: string): boolean {
  try { const u = new URL(url); return u.protocol === 'wss:' && u.hostname === 'ws.gmgn.ai' && u.pathname === '/v2/ws'; }
  catch { return false; }
}
// Optional adapter for an already-connected Playwright page; never launches/reloads.
export function attachCapture(page: Page, onEvent: (event: CaptureEvent) => void,
  onPayload: (payload: unknown, now: number, source: string) => void) {
  page.on('websocket', ws => {
    if (!isGmgnSocket(ws.url())) return;
    const source = 'wss://ws.gmgn.ai/v2/ws';
    const emit = (kind: CaptureEvent['kind']) => onEvent({ kind, source, observedAt: Date.now() });
    emit('open');
    const frame = (direction: 'received' | 'sent', payload: string | Buffer) => {
      const now = Date.now(); const value = decodeFrame(payload);
      if (value === null) { emit('invalid'); return; }
      onEvent({ kind: 'frame', source, direction, observedAt: now, schema: describeFrame(value) });
      if (direction === 'received') onPayload(value, now, source);
    };
    ws.on('framereceived', ({ payload }) => frame('received', payload));
    ws.on('framesent', ({ payload }) => frame('sent', payload));
    ws.on('close', () => emit('close'));
    ws.on('socketerror', () => emit('error'));
  });
}
