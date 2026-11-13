const test = require("node:test");
const assert = require("node:assert");
const { kindOf, usdcDelta, eventFromTx, summarize, MUSDC } = require("../src/lib/traction.cjs");

const bal = (owner, amount) => ({ mint: MUSDC, owner, uiTokenAmount: { amount: String(amount) } });
const tx = (wallet, ix, pre, post) => ({ blockTime: 1794580000, transaction: { message: { accountKeys: [{ pubkey: wallet }] } },
  meta: { err: null, logMessages: ix.map((n) => `Program log: Instruction: ${n}`), preTokenBalances: [bal(wallet, pre)], postTokenBalances: [bal(wallet, post)] } });

test("kindOf maps pm-AMM instruction logs", () => {
  assert.equal(kindOf(["Program log: Instruction: InitializeMarket", "Program log: Instruction: DepositLiquidity"]), "create");
  assert.equal(kindOf(["Program log: Instruction: Swap"]), "swap");
  assert.equal(kindOf(["Program log: Instruction: ResolveMarket"]), "resolve");
  assert.equal(kindOf(["Program log: Instruction: ClaimLpResiduals"]), "claim");
  assert.equal(kindOf([]), "unknown");
});

test("usdcDelta / eventFromTx: buy is negative mUSDC, sell positive", () => {
  const e = eventFromTx("M1", "s1", tx("W", ["Swap"], 50_000_000, 40_000_000));
  assert.deepEqual([e.kind, e.usdc, e.wallet], ["swap", -10, "W"]);
  assert.equal(usdcDelta(tx("W", ["Swap"], 0, 2_500_000).meta, "W"), 2.5);
  assert.equal(usdcDelta(tx("W", ["Swap"], 0, 2_500_000).meta, "X"), 0);
});

test("summarize never counts team wallets as outside", () => {
  const team = { keeper: ["K"], traderBot: ["T"], teamTest: ["E"] };
  const ev = [
    { sig: "a", market: "M1", at: 10, wallet: "K", kind: "create", usdc: -100 },
    { sig: "b", market: "M1", at: 11, wallet: "T", kind: "swap", usdc: -5 },
    { sig: "c", market: "M1", at: 12, wallet: "T", kind: "swap", usdc: 3 },
    { sig: "d", market: "M2", at: 13, wallet: "E", kind: "swap", usdc: -10 },
    { sig: "e", market: "M2", at: 14, wallet: "X1", kind: "swap", usdc: -7 },
    { sig: "f", market: "M2", at: 15, wallet: "X1", kind: "claim", usdc: 9 },
    { sig: "g", market: "M1", at: 16, wallet: "X2", kind: "swap", usdc: -1, err: 1 },
  ];
  const markets = [{ market: "M1", endTs: 5 }, { market: "M2", endTs: 999 }, { market: "M3", endTs: 999, dry: true }];
  const s = summarize(ev, { team, markets, resolutions: [{ market: "M1", signature: "r" }], now: 100 });
  assert.deepEqual(s.markets, { created: 2, resolved: 1, open: 1 });
  assert.equal(s.byGroup.traderBot.trades, 2); assert.equal(s.byGroup.traderBot.volumeUsdc, 8);
  assert.equal(s.byGroup.teamTest.trades, 1);
  assert.equal(s.byGroup.keeper.trades, 0);
  assert.equal(s.ours.trades, 3); assert.equal(s.ours.volumeUsdc, 18);
  assert.equal(s.outside.trades, 1); assert.equal(s.outside.volumeUsdc, 7); assert.equal(s.outside.wallets, 1); assert.equal(s.outside.claims, 1);
  assert.equal(s.all.volumeUsdc, 25); assert.equal(s.outsideShareOfVolume, 0.28);
  assert.equal(s.outsideWallets[0].wallet, "X1");
  assert.equal(summarize(ev, { team, markets, sinceTs: 14.5 }).outside.trades, 0);
});

test("static dashboard shows the ours-vs-outside table only when traction.json exists", () => {
  const { renderSite } = require("../src/lib/site.cjs");
  const { buildResolutionLog } = require("../src/lib/reslog.cjs");
  const log = buildResolutionLog({ created: [], resolved: [] });
  const t = summarize([{ sig: "x", market: "M", at: 1, wallet: "X", kind: "swap", usdc: -4 }], { team: { keeper: ["K"] }, markets: [{ market: "M", endTs: 9 }], now: 5, scannedAt: 5 });
  const html = renderSite(log, t);
  assert.match(html, /Honest traction: our wallets vs outside wallets/);
  assert.match(html, /Outside wallets/); assert.match(html, /team-wallets\.json/); assert.match(html, /app\/#try/);
  assert.doesNotMatch(renderSite(log), /Honest traction/);
});
