import { createServer, type Server } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { decodeFrame } from './parser.js';
export interface BridgeMessage {
  kind: 'frame' | 'open' | 'close' | 'error' | 'heartbeat';
  direction?: 'received' | 'sent'; payload?: string;
  source?: string; sourceVerified?: boolean;
}
export interface BridgeCommand { action: 'open-fomo'; mint: string; url: string }
export async function startBridge(
  onMessage: (message: BridgeMessage) => BridgeCommand[], port = 17891,
  token = randomBytes(24).toString('hex'),
): Promise<{ server: Server; token: string; port: number }> {
  const server = createServer(async (req, res) => {
    const origin = req.headers.origin ?? '';
    if (origin && !/^chrome-extension:\/\/[a-p]{32}$/.test(origin)) { res.writeHead(403).end(); return; }
    res.setHeader('Access-Control-Allow-Origin', origin || 'null');
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    if (req.method === 'OPTIONS') { res.writeHead(204).end(); return; }
    const actual = Buffer.from(req.headers.authorization ?? '');
    const expected = Buffer.from('Bearer ' + token);
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) { res.writeHead(401).end(); return; }
    if (req.method !== 'POST' || req.url !== '/ingest') { res.writeHead(404).end(); return; }
    let length = 0; const chunks: Buffer[] = [];
    try {
      for await (const chunk of req) {
        length += chunk.length;
        if (length > 2_100_000) { res.writeHead(413).end(); return; }
        chunks.push(chunk);
      }
      const message = decodeFrame(Buffer.concat(chunks)) as BridgeMessage | null;
      if (!message || !['frame','open','close','error','heartbeat'].includes(message.kind)
        || (message.kind === 'frame' && (typeof message.payload !== 'string' || !['received','sent'].includes(message.direction ?? '')))) {
        res.writeHead(400).end(); return;
      }
      const commands = onMessage(message);
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ ok: true, commands }));
    } catch { if (!res.headersSent) res.writeHead(400); res.end(); }
  });
  server.requestTimeout = 5000;
  server.headersTimeout = 5000;
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject); server.listen(port, '127.0.0.1', resolve);
  });
  const address = server.address();
  return { server, token, port: typeof address === 'object' && address ? address.port : port };
}
