const status = document.querySelector('#status');
const config = await chrome.storage.session.get(['endpoint','token']);
if (config.endpoint) document.querySelector('#endpoint').value = config.endpoint;
if (config.token) document.querySelector('#token').value = config.token;
async function show() { const state = await chrome.runtime.sendMessage({ action: 'status' }); status.textContent = JSON.stringify(state, null, 2); }
document.querySelector('#start').onclick = async () => {
  status.textContent = 'Menghubungkan...';
  const result = await chrome.runtime.sendMessage({ action: 'start', endpoint: document.querySelector('#endpoint').value, token: document.querySelector('#token').value });
  status.textContent = result.error || 'Listener aktif. Kembali ke GMGN seperti biasa.';
};
document.querySelector('#stop').onclick = async () => { await chrome.runtime.sendMessage({ action: 'stop' }); await show(); };
await show();
