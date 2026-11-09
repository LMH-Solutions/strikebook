const test = require("node:test");
const assert = require("node:assert");
const { buildResolutionLog, openMarkets } = require("../src/lib/reslog.cjs");

const created = [
  { market: "A", marketId: 1, name: "SOL>90@100", asset: "SOL", strike: 90, endTs: 100, fairYes: 0.5, initialPriceBps: 5000, spot: 90.1, sigmaAnnual: 0.6, createdAt: 10, signature: "c1" },
  { market: "B", marketId: 2, name: "SOL>95@100", asset: "SOL", strike: 95, endTs: 100, fairYes: 0.25, initialPriceBps: 2500, spot: 90.1, sigmaAnnual: 0.6, createdAt: 10, signature: "c2" },
  { market: "C", marketId: 3, name: "BTC>70000@50", asset: "BTC", strike: 70000, endTs: 50, fairYes: 0.5, initialPriceBps: 5000, createdAt: 5, signature: "c3" },
];
const trades = [
  { market: "A", at: 20, signature: "t1", ammAfter: 0.55, spot: 91, sigmaAnnual: 0.62, amountIn: 1e6, quotedOut: 2e6, fee: 2e4 },
  { market: "A", at: 30, signature: "t2", ammAfterEst: 0.58, spot: 91.5, sigmaAnnual: 0.63, amountIn: 1e6, quotedOut: 2e6, fee: 2e4 },
  { market: "A", at: 40, dry: true, signature: "t3", ammAfter: 0.99 },
];

test("openMarkets: unresolved only, latest real trade price, seed fallback, sorted", () => {
  const o = openMarkets({ created, seen: new Set(["C"]), trades, app: "https://x" });
  assert.deepStrictEqual(o.map((m) => m.market), ["B", "A"]);
  const a = o.find((m) => m.market === "A");
  assert.strictEqual(a.amm.yes, 0.58);
  assert.strictEqual(a.amm.trades, 2);
  assert.strictEqual(a.amm.spot, 91.5);
  assert.strictEqual(a.url, "https://x/market/1");
  assert.strictEqual(o.find((m) => m.market === "B").amm.yes, 0.25);
});

test("buildResolutionLog exposes open[] consistent with stats.openMarkets", () => {
  const log = buildResolutionLog({ created, resolved: [{ market: "C", name: "BTC>70000@50", asset: "BTC", strike: 70000, endTs: 50, side: "no", oraclePrice: 69000, oracleTs: 52, oracleSource: "pyth-onchain x", signature: "r" }], trades, app: "https://x" });
  assert.strictEqual(log.open.length, log.stats.openMarkets);
  assert.strictEqual(log.open.length, 2);
});
