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

const wallet = "5bmpgSv6LHyfX6EQ9XnreapgW2VoaDJNAK8mRSNZGZoT";
const otherWallet = "3dKvjSVXCa2s5ysv5MGtjQ8CF4XZ6MKKTds2uGotXpwD";
const at = Date.parse("2026-10-10T03:00:00Z");
const position = (symbol, lane, phase, extra = {}) => ({
  mint: wallet,
  wallet,
  symbol,
  laneLabel: lane,
  version:
    lane === "P4"
      ? "distribution-profit4-v1"
      : `distribution-bounce-dump-${lane.toLowerCase()}`,
  phase,
  entryAt: at,
  entryPrice: 1,
  exitAt: phase === "CLOSED" ? at + 10000 : null,
  exitPrice: phase === "CLOSED" ? 1.1 : null,
  netReturnPercent: phase === "CLOSED" ? 10 : null,
  pnlUsd: phase === "CLOSED" ? 0.5 : null,
  estimatedOpenNetPercent: phase === "OPEN" ? 99 : null,
  captureActive: true,
  facts: {
    now: at + 12000,
    price: 1.05,
    holderCount: 120,
    holderGrowth15s: 3,
    buyShareUsdPercent: 70,
  },
  ...extra,
});

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "profit4-ui-"));
  const base = join(root, "data", "profit4-watch");
  mkdirSync(join(root, "dist"), { recursive: true });
  copyFileSync(
    "dist/profit4-dashboard.html",
    join(root, "dist", "profit4-dashboard.html"),
  );
  for (const name of ["profit4-v1-vs-v4.html", "profit4-audit-dashboard.html"])
    writeFileSync(join(root, "dist", name), "<h1>Fixture report</h1>");
  mkdirSync(join(base, "live"), { recursive: true });
  mkdirSync(join(base, "archive"));
  writeFileSync(
    join(base, "dashboard-config.json"),
    JSON.stringify({ addresses: [wallet] }),
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
  const live = [
    position("Active P4", "P4", "OPEN"),
    position("Watch P4", "P4", "WATCHING", { entryAt: null }),
    ...Array.from({ length: 28 }, (_, i) =>
      position(`Closed ${String(i).padStart(2, "0")}`, "P4", "CLOSED"),
    ),
    position("Missing P4", "P4", "CENSORED", {
      netReturnPercent: 100,
      pnlUsd: 100,
    }),
    position("Quote P4", "P4", "CLOSED", {
      swapBuyPrice: 1.01,
      swapBuyOk: true,
      swapBuyLatencyMs: 100,
      swapSellPrice1: 1.09,
      swapSellPrice2: 1.1,
      swapSellOk1: true,
      swapSellOk2: true,
      swapSellDeltaPct: 0.9,
    }),
  ];
  writeFileSync(
    join(base, "live", "profit4-state.json"),
    JSON.stringify({
      observedAt: at + 12000,
      execution: "PAPER_QUOTE",
      targetPercent: 4,
      rules: {
        version: "saved-profit4-v1",
        observationSeconds: 30,
        minBuySharePercent: 50,
        stakeUsd: 5,
        targetPercent: 25,
      },
      positions: live,
      recentEvents: Array.from({ length: 65 }, (_, i) => ({
        type: "LIVE_FIXTURE_EVENT",
        observedAt: at + 12000 + i,
      })),
    }),
  );
  writeFileSync(
    join(base, "live", "manifest.json"),
    JSON.stringify({ startedAt: new Date(at).toISOString() }),
  );
  const archive = [
    position("Archived winner", "V1", "CLOSED", { pnlUsd: 2 }),
    position("Archived loser", "V2", "CLOSED", {
      netReturnPercent: -10,
      pnlUsd: -0.5,
    }),
    position("Archived V3", "V3", "CLOSED", { netReturnPercent: 0, pnlUsd: 0 }),
    position("Interrupted V4", "V4", "OPEN"),
    position("No entry", "V1", "CLOSED", {
      entryAt: null,
      netReturnPercent: null,
      pnlUsd: null,
    }),
  ];
  writeFileSync(
    join(base, "archive", "profit4-state.json"),
    JSON.stringify({
      observedAt: at,
      positions: archive,
      recentEvents: [{ type: "ARCHIVE_FIXTURE_EVENT", observedAt: at }],
    }),
  );
  const server = createProfit4Dashboard({
    root,
    adminPassword: "test-password",
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return {
    root,
    base,
    server,
    url: `http://127.0.0.1:${server.address().port}`,
  };
}

test(
  "Profit4 tabs consistently scope sessions, paper results, rules, filters and quotes",
  { timeout: 30000 },
  async () => {
    const f = await fixture();
    let browser;
    try {
      browser = await chromium.launch({ headless: true });
      const page = await browser.newPage({
        viewport: { width: 1440, height: 1000 },
      });
      const errors = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.goto(f.url + "/profit4");
      await page.waitForFunction(
        () => document.querySelector("#entries").textContent === "31",
      );
      assert.equal(await page.locator("#run").inputValue(), "live");
      assert.equal(await page.locator("#open").textContent(), "1");
      assert.equal(await page.locator("#pnl").textContent(), "+$14.50");
      assert.equal(await page.locator("#missing").textContent(), "1");
      assert.equal(
        await page
          .locator("#lane-rows")
          .innerText()
          .then((s) => s.includes("V1")),
        false,
      );
      assert.match(
        await page.locator("#rules").innerText(),
        /saved-profit4-v1/,
      );
      assert.match(
        await page.locator("#rules").innerText(),
        /Target sesi 4.00%/,
      );
      assert.equal(await page.locator("#observations tr").count(), 1);
      await page.locator('.desktop-tabs [data-tab="positions"]').click();
      assert.equal(await page.locator("#positions tr").count(), 1);
      assert.match(await page.locator("#positions").innerText(), /Active P4/);
      await page.locator('.desktop-tabs [data-tab="history"]').click();
      assert.equal(await page.locator("#history tr").count(), 25);
      assert.equal(await page.locator("#page-label").textContent(), "1 / 2");
      await page.locator("#next").click();
      assert.equal(await page.locator("#history tr").count(), 5);
      await page.locator("#phase").selectOption("missing");
      assert.match(await page.locator("#history").innerText(), /Missing P4/);
      assert.equal(
        await page
          .locator("#history")
          .innerText()
          .then((s) => s.includes("$100")),
        false,
      );
      await page.locator("#phase").selectOption("closed");
      await page.locator("#search").fill("Quote P4");
      assert.equal(await page.locator("#history tr").count(), 1);
      await page.locator("#search").fill("");
      await page.locator("#run").selectOption("archive");
      assert.equal(await page.locator("#pnl").textContent(), "+$1.50");
      assert.equal(await page.locator("#open").textContent(), "0");
      assert.equal(await page.locator("#positions tr").count(), 1); // empty-state row
      assert.match(
        await page.locator("#rules").innerText(),
        /Rules arsip tidak tersedia/,
      );
      assert.equal(
        await page
          .locator("#rules")
          .innerText()
          .then((s) => s.includes("saved-profit4")),
        false,
      );
      assert.match(
        await page.locator("#events").innerText(),
        /ARCHIVE_FIXTURE_EVENT/,
      );
      assert.equal(
        await page
          .locator("#events")
          .innerText()
          .then((s) => s.includes("LIVE_FIXTURE")),
        false,
      );
      await page.locator("#lane").selectOption("V2");
      assert.match(
        await page.locator("#history").innerText(),
        /Archived loser/,
      );
      await page.locator("#lane").selectOption("all");
      await page.locator("#hour").selectOption(String(at));
      assert.equal(await page.locator("#history tr").count(), 3);
      await page.locator('[data-sort="pnlUsd"]').click();
      assert.match(
        await page.locator("#history tr").first().innerText(),
        /Archived winner/,
      );
      await page.locator("#run").selectOption("all");
      assert.equal(await page.locator("#pnl").textContent(), "+$16.00");
      await page.locator('.desktop-tabs [data-tab="onchain"]').click();
      assert.match(
        await page.locator("#pane-onchain").innerText(),
        /Real Auto-Buy/,
      );
      assert.equal(await page.locator("#quotes tr").count(), 1);
      assert.match(await page.locator("#quotes").innerText(), /Quote P4/);
      await page.locator("#run").selectOption("archive");
      assert.match(await page.locator("#quotes").innerText(), /belum tersedia/);
      await page.locator("#wallet-input").fill(otherWallet);
      await page.locator("#add").click();
      await page.waitForResponse((r) => r.url().endsWith("/api/state"));
      assert.equal(await page.locator("#wallets tr").count(), 2);
      assert.equal(await page.locator("#run").inputValue(), "archive");
      await page.locator('#wallets [data-edit="1"]').click();
      await page.waitForResponse((r) => r.url().endsWith("/api/state"));
      assert.equal(
        await page.locator("#wallet-input").inputValue(),
        otherWallet,
      );
      await page.route("**/api/state", (route) =>
        route.fulfill({ status: 503, body: "unavailable" }),
      );
      await page.waitForFunction(() =>
        document
          .querySelector("#refresh-time")
          .textContent.includes("Pembaruan gagal"),
      );
      assert.equal(await page.locator("#pnl").textContent(), "+$1.50");
      await page.unroute("**/api/state");
      await page.waitForFunction(
        () => document.querySelector("#error").style.display === "none",
      );
      await page.reload();
      await page.waitForSelector("#pane-onchain.active");
      assert.equal(new URL(page.url()).hash, "#onchain");
      await page.goto(f.url + "/");
      await page.waitForSelector("#pane-onchain.active");
      assert.equal(
        await page.locator('[data-link="audit"]').getAttribute("href"),
        "/audit",
      );
      assert.equal(
        (await page.request.get(f.url + "/profit4/audit")).status(),
        200,
      );
      assert.equal(
        (await page.request.get(f.url + "/comparison")).status(),
        200,
      );
      await page.setViewportSize({ width: 390, height: 844 });
      assert.equal(await page.locator(".desktop-tabs").isVisible(), false);
      assert.equal(await page.locator(".bottom-nav").isVisible(), true);
      await page.locator('.bottom-nav [data-tab="history"]').click();
      assert.equal(await page.locator("#pane-history").isVisible(), true);
      assert.equal(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
        true,
      );
      assert.equal(
        await page
          .locator("#pane-history .table-wrap")
          .evaluate((e) => e.scrollWidth > e.clientWidth),
        true,
      );
      await page.screenshot({
        path: "/tmp/profit4-mobile.png",
        fullPage: true,
      });
      await page.setViewportSize({ width: 1440, height: 1000 });
      await page.locator('.desktop-tabs [data-tab="overview"]').click();
      await page.screenshot({
        path: "/tmp/profit4-desktop.png",
        fullPage: true,
      });
      assert.deepEqual(errors, []);
    } finally {
      await browser?.close();
      f.server.close();
      await once(f.server, "close");
      rmSync(f.root, { recursive: true, force: true });
    }
  },
);

test(
  "Profit4 empty data and stopped worker keep observation and interrupted exits distinct",
  { timeout: 15000 },
  async () => {
    const f = await fixture();
    let browser;
    try {
      writeFileSync(
        join(f.base, "worker-control.json"),
        JSON.stringify({ status: "stopped", run: join(f.base, "live") }),
      );
      browser = await chromium.launch({ headless: true });
      const page = await browser.newPage();
      await page.goto(f.url);
      await page.waitForFunction(
        () => document.querySelector("#entries").textContent === "35",
      );
      assert.equal(await page.locator("#run").inputValue(), "all");
      assert.equal(await page.locator("#open").textContent(), "0");
      assert.equal(await page.locator("#missing").textContent(), "3");
      assert.equal(await page.locator("#pnl").textContent(), "+$16.00");
      await page.locator("#run").selectOption("live");
      assert.equal(await page.locator("#entries").textContent(), "0");
      assert.equal(await page.locator("#pnl").textContent(), "$0.00");
      assert.match(await page.locator("#rules").innerText(), /belum tersedia/);
      assert.match(await page.locator("#worker-badge").innerText(), /STOPPED/);
    } finally {
      await browser?.close();
      f.server.close();
      await once(f.server, "close");
      rmSync(f.root, { recursive: true, force: true });
    }
  },
);

test(
  "Profit4 waits for slow refresh requests before scheduling the next poll",
  { timeout: 20000 },
  async () => {
    const f = await fixture();
    let browser;
    try {
      browser = await chromium.launch({ headless: true });
      const page = await browser.newPage();
      let concurrent = 0,
        maximum = 0,
        completed = 0;
      await page.route("**/api/state", async (route) => {
        concurrent++;
        maximum = Math.max(maximum, concurrent);
        try {
          const response = await route.fetch();
          await new Promise((resolve) => setTimeout(resolve, 2400));
          await route.fulfill({ response });
          completed++;
        } finally {
          concurrent--;
        }
      });
      await page.goto(f.url);
      await page.waitForFunction(
        () => document.querySelector("#entries").textContent === "31",
      );
      await page.locator('.desktop-tabs [data-tab="history"]').click();
      await page.locator("#phase").selectOption("missing");
      await page.locator("#search").fill("Missing");
      await page.waitForResponse((r) => r.url().endsWith("/api/state"));
      await page.waitForTimeout(100);
      assert.equal(completed, 2);
      assert.equal(maximum, 1);
      assert.equal(await page.locator("#phase").inputValue(), "missing");
      assert.equal(await page.locator("#search").inputValue(), "Missing");
      assert.match(await page.locator("#history").innerText(), /Missing P4/);
    } finally {
      await browser?.close();
      f.server.close();
      await once(f.server, "close");
      rmSync(f.root, { recursive: true, force: true });
    }
  },
);

test(
  "Real Auto-Buy form saves settings, preserves edits and opens authenticated audit",
  { timeout: 20000 },
  async () => {
    const f = await fixture();
    let browser;
    try {
      const { readLiveState, atomicJson } = await import(
        "../src/profit4-live-store.ts"
      );
      const live = readLiveState(f.base);
      live.readiness = {
        sessionReady: true,
        wallet,
        balanceSol: 1,
        solUsd: 100,
        observedAt: Date.now(),
        workerPid: process.pid,
        activeLanes: ["V1", "V2", "V3", "V4"],
      };
      live.positions = [
        {
          id: "a".repeat(64),
          signalId: "signal",
          run: "live",
          mint: wallet,
          symbol: "REAL FIXTURE",
          lane: "V4",
          wallet,
          status: "CLOSED",
          createdAt: at,
          updatedAt: at,
          remainingAmount: "0",
          buys: [],
          sells: [],
          audit: [{ at, type: "BUY_CONFIRMED", details: { amount: "1000" } }],
          rules: {},
          pnlSol: 0.01,
          pnlUsd: 1,
          cashflowComplete: true,
        },
      ];
      atomicJson(join(f.base, "real-state.json"), live);
      browser = await chromium.launch({ headless: true });
      const page = await browser.newPage({
        viewport: { width: 1440, height: 1000 },
      });
      const errors = [];
      page.on("pageerror", (e) => errors.push(e.message));
      await page.goto(f.url + "/profit4#onchain");
      await page.waitForSelector("#pane-onchain.active");
      assert.equal(
        await page.locator("#autobuy-fields").evaluate((e) => e.disabled),
        false,
      );
      assert.match(
        await page.locator("#real-trades").innerText(),
        /REAL FIXTURE/,
      );
      await page.locator("#real-stake-usd").fill("0.75");
      await page.waitForResponse((r) => r.url().endsWith("/api/state"));
      assert.equal(await page.locator("#real-stake-usd").inputValue(), "0.75");
      await page.locator("#real-save").click();
      await page.waitForFunction(
        () =>
          document.querySelector("#real-stake-usd").value === "0.75" &&
          document.querySelector("#error").style.display === "none",
      );
      const saved = await (
        await page.request.get(f.url + "/profit4/api/autobuy")
      ).json();
      assert.equal(saved.config.stakeUsd, 0.75);
      assert.equal(saved.config.enabled, false);
      if (await page.locator("#success-modal-ok").isVisible()) {
        await page.locator("#success-modal-ok").click();
      }
      await page.locator("[data-audit]").click();
      assert.equal(await page.locator("#real-audit-dialog").isVisible(), true);
      assert.match(
        await page.locator("#real-audit-content").innerText(),
        /BUY_CONFIRMED/,
      );
      await page.locator("#real-audit-close").click();
      await page.setViewportSize({ width: 390, height: 844 });
      assert.equal(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
        true,
      );
      await page.screenshot({
        path: "/tmp/profit4-real-mobile.png",
        fullPage: true,
      });
      await page.setViewportSize({ width: 1440, height: 1000 });
      await page.screenshot({
        path: "/tmp/profit4-real-desktop.png",
        fullPage: true,
      });
      assert.equal(
        (await page.request.get(f.url + "/profit4/api/real-trades")).status(),
        200,
      );
      assert.deepEqual(errors, []);
    } finally {
      await browser?.close();
      f.server.close();
      await once(f.server, "close");
      rmSync(f.root, { recursive: true, force: true });
    }
  },
);
