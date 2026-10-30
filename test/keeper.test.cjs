const test = require("node:test");
const assert = require("node:assert");
const { planLadder, nextExpiry, roundTick, autoTick } = require("../src/lib/ladder.cjs");
const { parseStrikeName, decide, sideFor } = require("../src/lib/resolver.cjs");
const { quoteSwapState, minOutput, assertDevnet } = require("../src/lib/pmamm.cjs");
const { capitalPhi } = require("@pm-amm/sdk/math");

const NOW = 1793360000;
test("planLadder: names parse back, strikes descend, seeds within pm-AMM bounds", () => {
  const r = planLadder({ asset: "BTC", spot: 77000, sigmaAnnual: 0.45, endTs: NOW + 6 * 3600, nowTs: NOW });
  assert.strictEqual(r.length, 5);
  for (let i = 0; i < r.length; i++) {
    assert.deepStrictEqual(parseStrikeName(r[i].name), { asset: "BTC", strike: r[i].strike, endTs: NOW + 6 * 3600 });
    assert.ok(r[i].initialPriceBps >= 100 && r[i].initialPriceBps <= 9900);
    assert.ok(Math.abs(r[i].fairYes - r[i].targetProb) < 0.05, `${r[i].fairYes} vs ${r[i].targetProb}`);
    if (i) assert.ok(r[i].strike < r[i - 1].strike);
  }
});
test("planLadder rejects < 300 s markets and dedupes collapsed rungs", () => {
  assert.throws(() => planLadder({ asset: "SOL", spot: 100, sigmaAnnual: 0.5, endTs: NOW + 100, nowTs: NOW }));
  const r = planLadder({ asset: "SOL", spot: 100, sigmaAnnual: 0.5, endTs: NOW + 400, nowTs: NOW, tick: 5 });
  assert.strictEqual(new Set(r.map((x) => x.strike)).size, r.length);
});
test("autoTick / roundTick / nextExpiry", () => {
  assert.strictEqual(autoTick(100, 0.57, 360, 0.5), 0.02);
  assert.strictEqual(autoTick(100, 0.57, 6 * 3600, 0.5), 0.2);
  assert.strictEqual(roundTick(96.537, 0.02), 96.54);
  assert.strictEqual(nextExpiry(21600 * 10 + 100, 21600), 21600 * 11);
  assert.strictEqual(nextExpiry(21600 * 11 - 60, 21600), 21600 * 12); // < 1h away: roll to next grid slot
});
test("resolver: strict > rule, waits for both name and on-chain expiry, uses oracle at name endTs", async () => {
  assert.strictEqual(sideFor(100.01, 100), "yes");
  assert.strictEqual(sideFor(100, 100), "no");
  let asked = null;
  const priceAt = async (asset, ts) => { asked = [asset, ts]; return { price: 101, publishTime: ts + 1, source: "mock" }; };
  const name = "SOL>100@1793360000";
  assert.strictEqual((await decide(name, 1793359999, { priceAt })).status, "not-expired");
  assert.strictEqual((await decide(name, 1793360001, { onchainEndTs: 1793360005, priceAt })).status, "not-expired");
  const d = await decide(name, 1793360010, { onchainEndTs: 1793360005, priceAt });
  assert.strictEqual(d.side, "yes");
  assert.deepStrictEqual(asked, ["SOL", 1793360000]);
  assert.strictEqual((await decide("Will it rain?", 2000, { priceAt })).status, "not-a-strike-market");
});
test("quoteSwap port: fee, price impact direction, minOutput", () => {
  const L = 1e8, u = 0; // 50/50 pool: x = y = L*phi(0)
  const x = L * (u * capitalPhi(u) + Math.exp(-u * u / 2) / Math.sqrt(2 * Math.PI) - u), y = x;
  const s = { x, y, lEff: L, price: 0.5, expired: false, resolved: false };
  const q = quoteSwapState(s, "usdcToYes", 5_000_000);
  assert.strictEqual(q.fee, 100_000);
  assert.ok(q.out > 5_000_000 * 0.98 && q.out < 5_000_000 * 0.98 / 0.5, String(q.out)); // ~2x at p=0.5 minus impact
  assert.strictEqual(minOutput({ out: 10_000 }), 9_900);
  assert.throws(() => quoteSwapState({ ...s, expired: true }, "usdcToYes", 1));
});
test("signing refuses mainnet RPC", () => {
  assert.throws(() => assertDevnet("https://api.mainnet-beta.solana.com"));
  assert.doesNotThrow(() => assertDevnet("https://api.devnet.solana.com"));
});
test("pythAt: retries until a print >= expiry, then every rung reuses the same settlement print", async () => {
  const { pythAt } = require("../src/lib/feeds.cjs");
  const T = 1793370000;
  let calls = 0;
  const latest = async () => { calls++; return { price: 100 + calls, conf: 0.05, publishTime: calls < 3 ? T - 1 : T + 1, source: "pyth-onchain mock" }; };
  const a = await pythAt("SOL", T, T + 3, { latest, retryMs: 1 });
  assert.strictEqual(calls, 3);
  assert.strictEqual(a.publishTime, T + 1);
  const b = await pythAt("SOL", T, T + 9, { latest, retryMs: 1 });
  assert.deepStrictEqual(b, a);
  assert.strictEqual(calls, 3);
});
