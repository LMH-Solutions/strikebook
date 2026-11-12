const test = require("node:test");
const assert = require("node:assert");
const { planTick, allocateRungs, rungProbs, RENT_PER_MARKET, SOL_RESERVE } = require("../src/lib/roller.cjs");
const { buildResolutionLog, SCHEMA } = require("../src/lib/reslog.cjs");
const { renderSite } = require("../src/lib/site.cjs");

const G = 6 * 3600, NOW = G * 83000 + 100; // just after a grid slot
const cfg = { assets: ["SOL", "BTC"], gridSecs: G, minLeadSecs: 3600, maxRungs: 3, deposit: 25 };
const rich = { sol: 1, usdc: 1000 };

test("rungProbs: ATM first, then wings, returned ascending", () => {
  assert.deepStrictEqual(rungProbs(1), [0.5]);
  assert.deepStrictEqual(rungProbs(3), [0.25, 0.5, 0.75]);
  assert.deepStrictEqual(rungProbs(5), [0.1, 0.25, 0.5, 0.75, 0.9]);
  assert.deepStrictEqual(rungProbs(0), []);
});

test("allocateRungs: round-robin across assets, bounded by SOL rent and mUSDC deposits", () => {
  assert.deepStrictEqual(allocateRungs({ assets: ["SOL", "BTC"], sol: 1, usdc: 1000, deposit: 25, maxRungs: 3 }), { SOL: 3, BTC: 3 });
  const sol3 = SOL_RESERVE + RENT_PER_MARKET * 3 + 0.001; // 3 markets of rent
  assert.deepStrictEqual(allocateRungs({ assets: ["SOL", "BTC"], sol: sol3, usdc: 1000, deposit: 25, maxRungs: 3 }), { SOL: 2, BTC: 1 });
  assert.deepStrictEqual(allocateRungs({ assets: ["SOL", "BTC"], sol: 1, usdc: 30, deposit: 25, maxRungs: 3 }), { SOL: 1, BTC: 0 });
  assert.deepStrictEqual(allocateRungs({ assets: ["SOL"], sol: 0.014, usdc: 900, deposit: 25, maxRungs: 3 }), { SOL: 0 });
});

test("planTick: fresh wallet creates one ladder per asset on the next grid expiry", () => {
  const p = planTick({ now: NOW, markets: [], balances: rich, cfg });
  assert.strictEqual(p.endTs, G * 83001);
  assert.deepStrictEqual(p.create.map((c) => [c.asset, c.probs.length, c.endTs]), [["SOL", 3, G * 83001], ["BTC", 3, G * 83001]]);
  assert.strictEqual(p.wantsFaucet, false);
  assert.deepStrictEqual(p.due, []);
});

test("planTick: rolls only after expiry, resolves due markets, ignores foreign names", () => {
  const exp = G * 83000; // expired 100 s ago
  const markets = [
    { name: `SOL>96@${exp}`, endTs: exp, resolved: false },
    { name: `SOL>97@${exp}`, endTs: exp, resolved: true },
    { name: `BTC>77000@${G * 83001}`, endTs: G * 83001, resolved: false }, // still live
    { name: "Will it rain?", endTs: exp, resolved: false },
  ];
  const p = planTick({ now: NOW, markets, balances: rich, cfg });
  assert.deepStrictEqual(p.due, [`SOL>96@${exp}`]);
  assert.deepStrictEqual(p.create.map((c) => c.asset), ["SOL"]);
  assert.deepStrictEqual(p.skipped.map((s) => [s.asset, s.reason]), [["BTC", "live-ladder"]]);
  // on-chain endTs later than the name: not due yet, and the ladder still counts as live
  const q = planTick({ now: NOW, markets: [{ name: `SOL>96@${exp}`, endTs: NOW + 5, resolved: false }], balances: rich, cfg: { ...cfg, assets: ["SOL"] } });
  assert.deepStrictEqual(q.due, []);
  assert.strictEqual(q.create.length, 0);
});

test("planTick: scarce SOL shrinks the ladder and asks for the faucet; broke wallet skips", () => {
  const p = planTick({ now: NOW, markets: [], balances: { sol: 0.09, usdc: 900 }, cfg });
  assert.deepStrictEqual(p.create.map((c) => [c.asset, c.probs]), [["SOL", [0.5]], ["BTC", [0.5]]]);
  assert.strictEqual(p.wantsFaucet, true);
  const q = planTick({ now: NOW, markets: [], balances: { sol: 0.014, usdc: 900 }, cfg });
  assert.strictEqual(q.create.length, 0);
  assert.deepStrictEqual(q.skipped.map((s) => s.reason), ["low-balance", "low-balance"]);
  assert.ok(q.solNeeded > 0.2 && q.solNeeded < 0.25);
});

const created = [
  { market: "M1", marketId: 1, name: "SOL>100@1000", asset: "SOL", strike: 100, endTs: 1000, fairYes: 0.3, initialPriceBps: 3000, spot: 99, sigmaAnnual: 0.5, signature: "c1", createdAt: 400 },
  { market: "M2", marketId: 2, name: "SOL>98@1000", asset: "SOL", strike: 98, endTs: 1000, fairYes: 0.7, initialPriceBps: 7000, spot: 99, sigmaAnnual: 0.5, signature: "c2", createdAt: 400 },
  { market: "M3", marketId: 3, name: "BTC>77000@2000", asset: "BTC", strike: 77000, endTs: 2000, fairYes: 0.5, signature: "c3", createdAt: 900 },
];
const res = (market, name, strike, side, extra = {}) => ({ market, name, asset: "SOL", strike, endTs: 1000, side, oraclePrice: 99.1, oracleConf: 0.05, oracleTs: 1002, oracleSource: "pyth-onchain X", signature: "r" + market, resolvedAt: 1005, dry: false, ...extra });

test("buildResolutionLog: joins seed + oracle proof, dedupes, drops dry runs, scores Brier", () => {
  const log = buildResolutionLog({ created, generatedAt: 5000, app: "https://app", claims: [{ market: "M2", kind: "claimWinnings", signature: "k1" }, { market: "M2", kind: "claimLpResiduals", skipped: "x" }],
    resolved: [res("M1", "SOL>100@1000", 100, "no"), res("M2", "SOL>98@1000", 98, "yes"), res("M2", "SOL>98@1000", 98, "no"), res("M3", "BTC>77000@2000", 77000, "yes", { dry: true })] });
  assert.strictEqual(log.schema, SCHEMA);
  assert.strictEqual(log.stats.resolved, 2);
  assert.strictEqual(log.stats.openMarkets, 1); // M3 only dry-resolved
  assert.strictEqual(log.stats.ladders, 1);
  assert.strictEqual(log.stats.brier, 0.09); // (0.3-0)^2 and (0.7-1)^2
  const m2 = log.resolutions.find((r) => r.market === "M2");
  assert.strictEqual(m2.side, "yes");
  assert.strictEqual(m2.oracle.lagSecs, 2);
  assert.deepStrictEqual(m2.claims, [{ kind: "claimWinnings", tx: "k1" }]);
  assert.strictEqual(m2.url, "https://app/market/2");
  assert.deepStrictEqual(log.ladders[0].rungs.sort(), ["M1", "M2"]);
  assert.strictEqual(log.stats.calibration.find((b) => b.range[0] === 0.6).yesRate, 1);
});

test("renderSite: static HTML lists every resolution with tx links and escapes names", () => {
  const log = buildResolutionLog({ created, resolved: [res("M1", "SOL>100@1000", 100, "no"), res("M2", "<b>x</b>", 98, "yes")], generatedAt: 5000, app: "https://app" });
  const html = renderSite(log);
  assert.ok(html.startsWith("<!doctype html>"));
  assert.ok(html.includes("solscan.io/tx/rM1?cluster=devnet"));
  assert.ok(html.includes("&lt;b&gt;x&lt;/b&gt;") && !html.includes("<b>x</b>"));
  assert.ok(html.includes("resolution-log.json"));
  assert.ok(!/<script/i.test(html)); // fully static
  const empty = renderSite(buildResolutionLog({ generatedAt: 1 }));
  assert.ok(empty.includes("No resolved markets yet"));
});

test("pickRpc: skips dead/unhealthy endpoints, signing guard checks the chosen endpoint", async () => {
  const { pickRpc, signingClient, connection } = require("../src/lib/pmamm.cjs");
  const fetchFn = async (url) => {
    if (url.includes("dead")) throw new Error("timeout");
    return { ok: true, json: async () => ({ result: url.includes("sick") ? "behind" : "ok" }) };
  };
  assert.strictEqual(await pickRpc(["https://dead.devnet", "https://sick.devnet", "https://good.devnet"], { fetchFn }), "https://good.devnet");
  await assert.rejects(pickRpc(["https://dead.devnet"], { fetchFn }));
  const { Keypair } = require("@solana/web3.js");
  assert.throws(() => signingClient(Keypair.generate(), connection("https://api.mainnet-beta.solana.com")), /devnet only/);
});

test("pollingConfirm: resolves on confirmed status, surfaces tx errors, no websocket", async () => {
  const { pollingConfirm } = require("../src/lib/pmamm.cjs");
  let n = 0;
  const conn = pollingConfirm({ getSignatureStatuses: async () => ({ value: [++n < 3 ? null : { slot: 9, confirmationStatus: "confirmed", err: null }] }) }, { intervalMs: 1 });
  assert.deepStrictEqual(await conn.confirmTransaction({ signature: "s", blockhash: "b", lastValidBlockHeight: 1 }), { context: { slot: 9 }, value: { err: null } });
  assert.strictEqual(n, 3);
  const bad = pollingConfirm({ getSignatureStatuses: async () => ({ value: [{ slot: 1, confirmationStatus: "processed", err: { x: 1 } }] }) }, { intervalMs: 1 });
  assert.deepStrictEqual((await bad.confirmTransaction("s")).value.err, { x: 1 });
});

test("claimsDone: signed claims are done; repeated permanent skips give up after 3 tries", () => {
  const { claimsDone } = require("../src/keeper.cjs");
  const d = claimsDone([
    { market: "A", kind: "claimWinnings", signature: "s" },
    { market: "B", kind: "claimWinnings", skipped: "Simulation failed." },
    { market: "B", kind: "claimWinnings", skipped: "Simulation failed." },
    { market: "C", kind: "claimWinnings", skipped: "Simulation failed." },
    { market: "C", kind: "claimWinnings", skipped: "Simulation failed." },
    { market: "C", kind: "claimWinnings", skipped: "Simulation failed." },
  ]);
  assert.deepStrictEqual([...d].sort(), ["A:claimWinnings", "C:claimWinnings"]);
});

// M4: deeper pools (100 mUSDC seed per rung), stepping down only when the wallet can't fund a full set of ladders
test("affordableDeposit / planTick: 100 mUSDC seeds when affordable, step down (floor 25) when short", () => {
  const { affordableDeposit } = require("../src/lib/roller.cjs");
  assert.equal(affordableDeposit({ usdc: 24000, target: 100, rungs: 6 }), 100);
  assert.equal(affordableDeposit({ usdc: 300, target: 100, minDeposit: 25, rungs: 6 }), 50);
  assert.equal(affordableDeposit({ usdc: 60, target: 100, minDeposit: 25, rungs: 6 }), 25);
  const now = 1_800_000_000 - 5 * 3600;
  const rich = planTick({ now, markets: [], balances: { sol: 1, usdc: 5000 }, cfg: { assets: ["SOL", "BTC"], maxRungs: 2, deposit: 100 } });
  assert.equal(rich.deposit, 100); assert.ok(rich.create.length === 2 && rich.create.every((c) => c.deposit === 100));
  const poor = planTick({ now, markets: [], balances: { sol: 1, usdc: 200 }, cfg: { assets: ["SOL", "BTC"], maxRungs: 2, deposit: 100 } });
  assert.equal(poor.deposit, 50); assert.equal(poor.create.reduce((s, c) => s + c.probs.length, 0), 4, "depth never costs rungs");
});
