import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import {
  mkdtempSync,
  mkdirSync,
  copyFileSync,
  writeFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { createProfit4Dashboard } from "../scripts/serve-profit4-dashboard.mjs";

test("Airdrop Clusters API and Dashboard UI integration", { timeout: 30000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), "profit4-clusters-"));
  const base = join(root, "data", "profit4-watch");
  mkdirSync(join(root, "dist"), { recursive: true });
  copyFileSync(
    "dist/profit4-dashboard.html",
    join(root, "dist", "profit4-dashboard.html"),
  );
  mkdirSync(join(base, "live"), { recursive: true });
  mkdirSync(join(base, "archive"), { recursive: true });

  const mockClusters = {
    updatedAt: "2026-10-14T10:00:00.000Z",
    totalClusters: 2,
    totalWallets: 16,
    totalTokens: 2,
    clusters: [
      {
        id: "cluster-5bmpgSv6",
        label: "Cluster 1 (5bmpgSv6...)",
        primaryTracked: "5bmpgSv6LHyfX6EQ9XnreapgW2VoaDJNAK8mRSNZGZoT",
        walletsCount: 8,
        tokensCount: 1,
        lastActivityAt: "2026-10-14T09:30:00.000Z",
        tokens: [
          {
            mint: "MetaAI1111111111111111111111111111111111111",
            symbol: "Meta AI",
            txCount: 1,
          },
        ],
        wallets: [
          {
            address: "5bmpgSv6LHyfX6EQ9XnreapgW2VoaDJNAK8mRSNZGZoT",
            isTracked: true,
          },
          {
            address: "E5ge3gxoN57YdQZ6Q35UiVE4vs6WNWHRh5dEHXRHD8mE",
            isTracked: false,
          },
          {
            address: "6SDacd9KLdicpJxMmbvRw2LzvK5CqmXkFT6b4Qmhz76H",
            isTracked: false,
          },
        ],
      },
      {
        id: "cluster-3dKvjSVX",
        label: "Cluster 2 (3dKvjSVX...)",
        primaryTracked: "3dKvjSVXCa2s5ysv5MGtjQ8CF4XZ6MKKTds2uGotXpwD",
        walletsCount: 8,
        tokensCount: 1,
        lastActivityAt: "2026-10-14T09:45:00.000Z",
        tokens: [
          {
            mint: "FOMO111111111111111111111111111111111111111",
            symbol: "FOMO",
            txCount: 1,
          },
        ],
        wallets: [
          {
            address: "3dKvjSVXCa2s5ysv5MGtjQ8CF4XZ6MKKTds2uGotXpwD",
            isTracked: true,
          },
          {
            address: "EAh4k1EGZobc9B3rt27JDUjWRFZdmwgSfWFFvGNYaRAX",
            isTracked: false,
          },
        ],
      },
    ],
  };

  writeFileSync(
    join(base, "airdrop-clusters.json"),
    JSON.stringify(mockClusters, null, 2),
  );
  writeFileSync(
    join(base, "dashboard-config.json"),
    JSON.stringify({
      addresses: ["5bmpgSv6LHyfX6EQ9XnreapgW2VoaDJNAK8mRSNZGZoT"],
    }),
  );
  writeFileSync(
    join(base, "worker-control.json"),
    JSON.stringify({
      pid: process.pid,
      mode: "profit4-watch",
      run: join(base, "live"),
      status: "running",
    }),
  );
  writeFileSync(
    join(base, "live", "profit4-state.json"),
    JSON.stringify({
      observedAt: Date.now(),
      positions: [],
      recentEvents: [],
    }),
  );

  const server = createProfit4Dashboard({ root });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const url = `http://127.0.0.1:${server.address().port}`;

  let browser;
  try {
    // 1. Test API endpoint GET /api/airdrop-clusters
    const apiRes = await fetch(`${url}/api/airdrop-clusters`);
    assert.equal(apiRes.status, 200);
    const apiData = await apiRes.json();
    assert.equal(apiData.totalClusters, 2);
    assert.equal(apiData.totalWallets, 16);
    assert.equal(apiData.clusters.length, 2);

    // 2. Test Browser UI
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({
      viewport: { width: 1440, height: 1000 },
    });
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));

    await page.goto(`${url}/profit4#clusters`);
    await page.waitForSelector("#pane-clusters.active");

    // Check cluster stat cards
    await page.waitForFunction(
      () => document.querySelector("#cluster-stat-total")?.textContent === "2",
    );
    assert.equal(
      await page.locator("#cluster-stat-total").innerText(),
      "2",
    );
    assert.equal(
      await page.locator("#cluster-stat-wallets").innerText(),
      "16",
    );

    // Verify rendered cluster cards and badge
    const content = await page.locator("#clusters-container").innerText();
    assert.match(content, /Cluster 1 \(5bmpgSv6\.\.\.\)/);
    assert.match(content, /Cluster 2 \(3dKvjSVX\.\.\.\)/);
    assert.match(content, /Meta AI/);
    assert.match(content, /FOMO/);
    assert.match(content, /E5ge3gxoN57YdQZ6Q35UiVE4vs6WNWHRh5dEHXRHD8mE/);

    // Verify copy button exists
    assert.ok(await page.locator(".btn-copy").first().isVisible());

    // Take screenshot of clusters UI for verification
    await page.screenshot({
      path: "/tmp/profit4-clusters-tab.png",
      fullPage: true,
    });

    assert.deepEqual(errors, []);
  } finally {
    await browser?.close();
    server.close();
    await once(server, "close");
    rmSync(root, { recursive: true, force: true });
  }
});
