import test from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, unlinkSync, existsSync } from "node:fs";
import { join } from "node:path";
import { SnowballCollector, computeWalletTier } from "../src/snowball-collector.js";

test("SnowballCollector: correctly loads existing wallets and ingests new smart traders", () => {
  const tmpCurated = join(process.cwd(), "data", ".test-curated.json");
  const tmpAudit = join(process.cwd(), "data", ".test-audit.json");

  // Mock curated data
  writeFileSync(tmpCurated, JSON.stringify({
    totalCurated: 1,
    wallets: [
      {
        address: "WalletExisting1111111111111111111111111111111",
        score: 80,
        winrate30d: 65,
        pnl30d: 3000,
        solBalance: 10,
        source: "gmgn_curator",
        successfulTokens: ["TOKENA"],
        hitCount: 1
      }
    ]
  }));

  // Mock audit with 1 quarantined syndicate
  writeFileSync(tmpAudit, JSON.stringify({
    syndicatesDetected: ["SyndicateBadActor111111111111111111111111111"]
  }));

  const collector = new SnowballCollector({
    curatedPath: tmpCurated,
    auditPath: tmpAudit
  });

  assert.equal(collector.getAllAddresses().length, 1);
  assert.equal(collector.isQuarantined("SyndicateBadActor111111111111111111111111111"), true);

  // 1. Quarantined trader should be rejected
  const res1 = collector.ingestTrader({
    address: "SyndicateBadActor111111111111111111111111111",
    profit: 500
  }, "SCAM", "mint1");
  assert.equal(res1.isNew, false);

  // 2. Bundler trader should be rejected
  const res2 = collector.ingestTrader({
    address: "BundlerWallet11111111111111111111111111111111",
    profit: 500,
    maker_token_tags: ["bundler"]
  }, "SCAM2", "mint2");
  assert.equal(res2.isNew, false);

  // 3. Low profit trader should be rejected (< $50)
  const res3 = collector.ingestTrader({
    address: "LowProfit11111111111111111111111111111111111",
    profit: 10
  }, "MEH", "mint3");
  assert.equal(res3.isNew, false);

  // 4. Valid new smart trader should be accepted and added
  const res4 = collector.ingestTrader({
    address: "GoodTrader2222222222222222222222222222222222",
    profit: 450,
    realized_pnl: 1.5,
    native_balance: "15000000000", // 15 SOL
    is_suspicious: false
  }, "ALPHA", "mint4");
  assert.equal(res4.isNew, true);
  assert.equal(res4.wallet?.source, "snowball_runner");
  assert.equal(res4.wallet?.solBalance, 15);
  assert.equal(collector.getAllAddresses().length, 2);

  // 5. Existing trader should increment hit count and token
  const res5 = collector.ingestTrader({
    address: "WalletExisting1111111111111111111111111111111",
    profit: 300
  }, "ALPHAB", "mint5");
  assert.equal(res5.isNew, false);
  assert.equal(res5.wallet?.hitCount, 2);
  assert.deepEqual(res5.wallet?.successfulTokens, ["TOKENA", "ALPHAB"]);

  // 6. Test saveSnowball
  const saveRes = collector.saveSnowball();
  assert.equal(saveRes.totalCurated, 2);
  assert.equal(saveRes.newSnowballed, 1);

  // 7. Test computeWalletTier for SSS, SS, S
  assert.equal(computeWalletTier({ hitCount: 55, pnl30d: 30000, solBalance: 25 }), "SSS");
  assert.equal(computeWalletTier({ hitCount: 22, pnl30d: 110000, solBalance: 16 }), "SSS");
  assert.equal(computeWalletTier({ hitCount: 22, pnl30d: 10000, solBalance: 5 }), "SS");
  assert.equal(computeWalletTier({ hitCount: 38, pnl30d: 6000, solBalance: 3.5 }), "SS");
  assert.equal(computeWalletTier({ hitCount: 1, pnl30d: 35000, solBalance: 12 }), "SS");
  assert.equal(computeWalletTier({ source: "gmgn_curator", pnl30d: 2500 }), "S");
  assert.equal(computeWalletTier({ hitCount: 8, pnl30d: 2500, solBalance: 3 }), "S");

  // Clean up
  if (existsSync(tmpCurated)) unlinkSync(tmpCurated);
  if (existsSync(tmpAudit)) unlinkSync(tmpAudit);
});
