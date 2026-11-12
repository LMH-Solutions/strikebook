const test = require("node:test"); const assert = require("node:assert");
const { decideExit } = require("../src/lib/trader.cjs");
const s = (price) => ({ price, resolved: false, expired: false, secondsLeft: 3600 });
test("sells YES when AMM bid beats model", () => { const d = decideExit({ s: s(0.7), pModel: 0.5, side: "yes", tokens: 10e6 }); assert.equal(d.action, "sell"); assert.equal(d.dir, "yesToUsdc"); assert.equal(d.amount, 5e6); });
test("holds when model still favours inventory", () => assert.equal(decideExit({ s: s(0.5), pModel: 0.6, side: "yes", tokens: 10e6 }).action, "hold"));
test("NO side mirrors", () => assert.equal(decideExit({ s: s(0.2), pModel: 0.5, side: "no", tokens: 10e6 }).dir, "noToUsdc"));
test("closed / empty / tiny hold", () => { assert.equal(decideExit({ s: { ...s(0.9), resolved: true }, pModel: 0.1, side: "yes", tokens: 1e7 }).reason, "closed"); assert.equal(decideExit({ s: s(0.9), pModel: 0.1, side: "yes", tokens: 0 }).reason, "no-inventory"); assert.equal(decideExit({ s: s(0.9), pModel: 0.1, side: "yes", tokens: 1e6 }).reason, "too-small"); });

// M4: exact-quote exit sizing + sell records in stats / resolution log / dashboard
const { capitalPhi } = require("@pm-amm/sdk/math");
const { planExit, priceAfterSell, tradeStats, usdcOf } = require("../src/lib/trader.cjs");
const { quoteSwapState, xFromY } = require("../src/lib/pmamm.cjs");
const { buildResolutionLog } = require("../src/lib/reslog.cjs");
const { renderSite } = require("../src/lib/site.cjs");
// pool on the pm-AMM curve at YES price p: u = Phi^-1(p), y = L*(u*Phi(u)+phi(u)), x = y - u*L
function pool(p, L = 100e6) {
  let lo = -6, hi = 6; for (let i = 0; i < 100; i++) { const m = (lo + hi) / 2; if (capitalPhi(m) < p) lo = m; else hi = m; }
  const u = (lo + hi) / 2, y = L * (u * capitalPhi(u) + Math.exp(-u * u / 2) / Math.sqrt(2 * Math.PI)), x = y - u * L;
  return { x, y, lEff: L, price: capitalPhi((y - x) / L), secondsLeft: 3 * 3600, expired: false, resolved: false, winner: null };
}

test("planExit: sells YES when the model flips, exact proceeds beat the hold value, price moves down", () => {
  const s = pool(0.7);
  assert.ok(Math.abs(s.price - 0.7) < 1e-9 && Math.abs(xFromY(s.y, s.lEff) - s.x) < 10, "on the curve");
  const x = planExit({ s, pModel: 0.3, side: "yes", tokens: 30e6 });
  assert.equal(x.action, "sell"); assert.equal(x.dir, "yesToUsdc");
  assert.equal(x.quotedOut, quoteSwapState(s, "yesToUsdc", x.amount).out, "proceeds are the exact on-chain quote");
  assert.ok(x.avgPrice - 0.3 >= 0.005 && x.evMicro > 0);
  assert.ok(x.ammAfterEst < s.price && Math.abs(x.ammAfterEst - priceAfterSell(s, "yes", x.amount)) < 1e-12);
  assert.ok(x.amount <= 15e6, "never more than maxFraction of inventory");
});

test("planExit: NO mirrors, holds when the model still favours inventory, bisects size down on a thin pool", () => {
  const lo = pool(0.45);
  assert.equal(planExit({ s: lo, pModel: lo.price + 0.2, side: "yes", tokens: 30e6 }).action, "hold");
  const no = planExit({ s: pool(0.3), pModel: 0.8, side: "no", tokens: 30e6 });
  assert.equal(no.action, "sell"); assert.equal(no.dir, "noToUsdc");
  assert.ok(no.ammAfterEst > pool(0.3).price, "selling NO lifts YES");
  const thin = pool(0.6, 8e6); // small pool: selling half of 400 tokens would crash the average price, so the plan bisects down
  const big = planExit({ s: thin, pModel: 0.52, side: "yes", tokens: 400e6 });
  assert.equal(big.action, "sell");
  assert.ok(big.amount < 200e6 && big.amount > 1e6, String(big.amount));
  assert.ok(big.avgPrice - 0.52 >= 0.005 && big.quotedOut >= 1e6);
  assert.ok(quoteSwapState(thin, "yesToUsdc", big.amount + 2000).out / (big.amount + 2000) - 0.52 < 0.005 + 1e-4, "near the largest size that clears the margin");
});

test("sell records: stats count proceeds as volume, the log and the dashboard label SELL", () => {
  const buy = { market: "M1", name: "SOL>100@1", side: "yes", amountIn: 10e6, quotedOut: 15e6, fee: 0.2e6, pModel: 0.6, ammBefore: 0.5, ammAfter: 0.55, signature: "b", at: 10 };
  const sell = { action: "sell", market: "M1", name: "SOL>100@1", side: "yes", amountIn: 5e6, quotedOut: 3.5e6, fee: 0.07e6, pModel: 0.4, ammBefore: 0.75, ammAfter: 0.7, signature: "s", at: 20 };
  assert.equal(usdcOf(sell), 3.5e6); assert.equal(usdcOf(buy), 10e6);
  const st = tradeStats([buy, sell]);
  assert.equal(st.trades, 2); assert.equal(st.sells, 1); assert.equal(st.volumeUsdc, 13.5);
  const log = buildResolutionLog({ trades: [buy, sell] });
  const row = log.trades.find((t) => t.tx === "s");
  assert.equal(row.action, "sell"); assert.equal(row.amountUsdc, 3.5); assert.equal(row.tokensOut, 5);
  assert.equal(log.trades.find((t) => t.tx === "b").action, "buy");
  const html = renderSite(log);
  assert.match(html, /SELL YES/); assert.match(html, /BUY YES/);
});
