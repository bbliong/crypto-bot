#!/usr/bin/env node
/**
 * scripts/run-dashboard-tunnel.mjs
 * Persistent Cloudflare Tunnel for AGY Dashboard (Port 4180)
 * Automatically exposes http://127.0.0.1:4180 as a trusted HTTPS URL
 * and persists the URL to .dashboard-tunnel-url for the dashboard UI.
 */

import { spawn } from 'node:child_process';
import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, '..');
const urlFile = join(projectRoot, '.dashboard-tunnel-url');
const cloudflaredBin = '/home/bbliong/.local/bin/cloudflared';

const targetPort = process.env.AGGRESSIVE_DASHBOARD_PORT || '4180';
const targetUrl = `http://127.0.0.1:${targetPort}`;
const tokenFile = join(projectRoot, 'config', 'tunnel-token.txt');

console.log(`[Tunnel] Initializing Cloudflare Tunnel for ${targetUrl}...`);

function startTunnel() {
  if (!existsSync(cloudflaredBin)) {
    console.error(`[Tunnel] ERROR: cloudflared binary not found at ${cloudflaredBin}`);
    process.exit(1);
  }

  let tunnelToken = process.env.CLOUDFLARE_TUNNEL_TOKEN || null;
  if (!tunnelToken && existsSync(tokenFile)) {
    try {
      const content = readFileSync(tokenFile, 'utf8').trim();
      if (content && !content.startsWith('#')) {
        tunnelToken = content;
      }
    } catch (e) {}
  }

  const args = tunnelToken
    ? ['tunnel', 'run', '--token', tunnelToken]
    : ['tunnel', '--url', targetUrl, '--no-autoupdate'];

  console.log(`[Tunnel] Starting cloudflared (${tunnelToken ? 'Named Permanent Tunnel with Token' : 'Quick Tunnel trycloudflare.com'})...`);

  const child = spawn(cloudflaredBin, args, {
    stdio: ['ignore', 'pipe', 'pipe']
  });

  let currentUrl = null;

  function handleOutput(data) {
    const text = data.toString();
    process.stdout.write(text);

    const m = text.match(/(https:\/\/[a-zA-Z0-9-]+\.trycloudflare\.com)/);
    if (m && m[1] && m[1] !== currentUrl) {
      currentUrl = m[1];
      console.log(`\n============================================================`);
      console.log(`🚀 [Tunnel] ACTIVE HTTPS PWA URL: ${currentUrl}`);
      console.log(`============================================================\n`);
      try {
        writeFileSync(urlFile, currentUrl.trim(), 'utf8');
      } catch (err) {
        console.error('[Tunnel] Failed to write URL file:', err);
      }
    }
  }

  child.stdout.on('data', handleOutput);
  child.stderr.on('data', handleOutput);

  child.on('close', (code) => {
    console.warn(`[Tunnel] Process exited with code ${code}. Restarting in 5s...`);
    setTimeout(startTunnel, 5000);
  });

  child.on('error', (err) => {
    console.error('[Tunnel] Process error:', err);
  });
}

startTunnel();
