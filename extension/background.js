const roots = new Map();
const sockets = new Map();
const sessions = new Set();
let settings, heartbeat, sent = 0, errors = 0, dropped = 0, inFlight = 0, lastError = '';
let fomoTab;
function gmgnUrl(raw) {
  try { const u = new URL(raw.startsWith('blob:') ? raw.slice(5) : raw); return u.protocol === 'https:' && (u.hostname === 'gmgn.ai' || u.hostname.endsWith('.gmgn.ai')); } catch { return false; }
}
function socketKey(source, id) { return JSON.stringify([source.tabId, source.targetId, source.sessionId, id]); }
function sourceKey(source) { return JSON.stringify([source.tabId, source.targetId, source.sessionId]); }
function rootKey(source) { return JSON.stringify(source.tabId !== undefined ? { tabId: source.tabId } : { targetId: source.targetId }); }
function owned(source) { return roots.has(rootKey(source)) && (!source.sessionId || sessions.has(sourceKey(source))); }
async function deliver(message) {
  if (!settings) return;
  if (inFlight >= 16) { dropped++; return; }
  inFlight++;
  try {
    const response = await fetch(current.endpoint + '/ingest', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + current.token },
      body: JSON.stringify(message), signal: AbortSignal.timeout(4000),
    });
    if (!response.ok) throw new Error('Local server HTTP ' + response.status);
    const result = await response.json(); sent++;
    for (const command of result.commands ?? []) {
      if (settings !== current || !roots.size) break;
      if (command.action !== 'open-fomo' || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(command.mint)) continue;
      // Restrict all browser-opening commands to the URL pattern supplied by the user.
      if (command.url !== 'https://fomo.family/tokens/solana/' + command.mint) continue;
      if (fomoTab) {
        try { await chrome.tabs.update(fomoTab, { url: command.url, active: true }); continue; } catch { fomoTab = undefined; }
      }
      const tab = await chrome.tabs.create({ url: command.url }); fomoTab = tab.id;
    }
    if (settings === current) lastError = '';
  } catch (error) { errors++; if (settings === current) lastError = String(error.message).slice(0, 120); }
  finally { inFlight--; }
}
async function enable(source) {
  await chrome.debugger.sendCommand(source, 'Network.enable');
  try { await chrome.debugger.sendCommand(source, 'Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true }); } catch {}
}
async function attach(source) {
  const key = rootKey(source);
  if (roots.has(key)) return;
  await chrome.debugger.attach(source, '1.3');
  roots.set(key, source);
  try { await enable(source); } catch (e) { roots.delete(key); await chrome.debugger.detach(source).catch(()=>{}); throw e; }
}
async function stop() {
  settings = undefined;
  if (heartbeat) clearInterval(heartbeat);
  heartbeat = undefined;
  const attached = [...roots.values()]; roots.clear(); sockets.clear(); sessions.clear();
  await Promise.allSettled(attached.map(source => chrome.debugger.detach(source)));
  settings = undefined;
}
chrome.debugger.onEvent.addListener((source, method, params) => {
  if (!settings) return;
  if (method === 'Target.attachedToTarget') {
    if (['worker','shared_worker','service_worker','iframe'].includes(params.targetInfo.type) && gmgnUrl(params.targetInfo.url || '')) {
      const child = { ...source, sessionId: params.sessionId };
      sessions.add(sourceKey(child));
      void enable(child).catch(()=>{ sessions.delete(sourceKey(child)); errors++; });
    }
    return;
  }
  if (method === 'Target.detachedFromTarget') {
    sessions.delete(sourceKey({ ...source, sessionId: params.sessionId }));
    return;
  }
  if (method === 'Network.webSocketCreated') {
    let matched = false;
    try { const u = new URL(params.url); matched = u.protocol === 'wss:' && u.hostname === 'ws.gmgn.ai' && u.pathname === '/v2/ws'; } catch {}
    sockets.set(socketKey(source, params.requestId), matched);
    if (matched) void deliver({ kind: 'open', source: 'wss://ws.gmgn.ai/v2/ws', sourceVerified: true });
  } else if (['Network.webSocketFrameReceived','Network.webSocketFrameSent'].includes(method)) {
    const known = sockets.get(socketKey(source, params.requestId));
    if (known === false) return;
    if (params.response.opcode !== 1 || params.response.payloadData.length > 2000000) return;
    const payload = params.response.payloadData;
    // Existing sockets have no replayed handshake; accept only GMGN-shaped JSON frames
    // from explicitly attached GMGN targets, and mark endpoint identity unverified.
    if (known === undefined) {
      try { const data = JSON.parse(payload); if (!data || typeof data.channel !== 'string' || !Array.isArray(data.data)) return; } catch { return; }
    }
    void deliver({ kind: 'frame', direction: method.endsWith('Received') ? 'received' : 'sent', payload,
      source: known ? 'wss://ws.gmgn.ai/v2/ws' : 'gmgn-existing-socket', sourceVerified: known === true });
  } else if (method === 'Network.webSocketClosed' || method === 'Network.webSocketFrameError') {
    const key = socketKey(source, params.requestId);
    if (sockets.get(key)) void deliver({ kind: method.endsWith('Closed') ? 'close' : 'error' });
    sockets.delete(key);
  }
});
chrome.debugger.onDetach.addListener(source => {
  roots.delete(JSON.stringify(source));
  lastError = 'Debugger detached. Klik Mulai lagi jika ingin melanjutkan.';
});
// Stop collecting immediately if the selected page leaves GMGN.
chrome.tabs.onUpdated.addListener((tabId, change) => {
  const source = { tabId };
  if (change.url && !gmgnUrl(change.url) && roots.has(rootKey(source))) {
    void stop().then(() => { lastError = 'Tab meninggalkan GMGN. Aktifkan GMGN dan klik Mulai lagi.'; });
  }
});
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  (async () => {
    if (message.action === 'status') return { attachedTargets: roots.size, sent, errors, dropped, lastError };
    if (message.action === 'stop') { await stop(); return { ok: true }; }
    if (message.action !== 'start') throw new Error('Unknown command');
    const endpoint = new URL(message.endpoint);
    if (endpoint.protocol !== 'http:' || endpoint.hostname !== '127.0.0.1' || endpoint.username || endpoint.password || endpoint.pathname !== '/' || endpoint.search || endpoint.hash) throw new Error('Gunakan endpoint http://127.0.0.1:17891');
    if (!/^[a-f0-9]{48}$/.test(message.token)) throw new Error('Kode koneksi tidak valid');
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id || !gmgnUrl(tab.url || '')) throw new Error('Aktifkan tab GMGN terlebih dahulu.');
    await stop();
    settings = { endpoint: endpoint.origin, token: message.token };
    await chrome.storage.session.set(settings);
    await deliver({ kind: 'heartbeat' });
    if (lastError) throw new Error(lastError);
    await attach({ tabId: tab.id });
    // Shared workers may already exist outside the page target.
    for (const target of await chrome.debugger.getTargets()) {
      if (['worker','shared_worker','service_worker'].includes(target.type) && gmgnUrl(target.url || '') && !target.attached) {
        await attach({ targetId: target.id }).catch(()=>{errors++;});
      }
    }
    heartbeat = setInterval(() => { void deliver({ kind: 'heartbeat' }); }, 5000);
    return { ok: true };
  })().then(respond).catch(error => { lastError = error.message; respond({ error: error.message }); });
  return true;
});

