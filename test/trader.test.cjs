const test = require("node:test");
const assert = require("node:assert");
const { capitalPhi } = require("@pm-amm/sdk/math");
const { decideTrade, modelProb, stateAfterBuy, tradeStats, FEE } = require("../src/lib/trader.cjs");
const { quoteSwapState, xFromY, yFromX } = require("../src/lib/pmamm.cjs");
const { buildResolutionLog } = require("../src/lib/reslog.cjs");
const { renderSite } = require("../src/lib/site.cjs");

// A pool on the pm-AMM curve (micro-USDC units, like marketState() returns): pick y, solve x on the invariant.
function pool(y = 10e6, L = 25e6, secondsLeft = 3 * 3600) {
  const x = xFromY(y, L);
  return { x, y, lEff: L, price: capitalPhi((y - x) / L), secondsLeft, expired: false, resolved: false, winner: null };
}

test("stateAfterBuy matches the exact quote and moves price the right way", () => {
  const s = pool();
  const yes = stateAfterBuy(s, "usdcToYes", 5e6), no = stateAfterBuy(s, "usdcToNo", 5e6);
  assert.ok(yes.price > s.price && no.price < s.price, `${s.price} ${yes.price} ${no.price}`);
  const q = quoteSwapState(s, "usdcToYes", 5e6), d = 5e6 * (1 - FEE);
  assert.ok(Math.abs(q.out - (d + (s.x - yes.x))) <= 1, "YES out = net in + x drop");
  assert.ok(Math.abs(yFromX(xFromY(s.y, s.lEff), s.lEff) - s.y) < 1, "curve solvers invert each other");
});

test("modelProb: ATM is just under 50% (lognormal drift), deep ITM/OTM saturate, expired is binary", () => {
  const now = 1_800_000_000, endTs = now + 6 * 3600;
  const atm = modelProb({ spot: 100, strike: 100, sigmaAnnual: 0.5, endTs, now });
  assert.ok(atm < 0.5 && atm > 0.49);
  assert.ok(modelProb({ spot: 100, strike: 80, sigmaAnnual: 0.5, endTs, now }) > 0.99);
  assert.ok(modelProb({ spot: 100, strike: 120, sigmaAnnual: 0.5, endTs, now }) < 0.01);
  assert.strictEqual(modelProb({ spot: 101, strike: 100, sigmaAnnual: 0.5, endTs: now - 1, now }), 1);
});

test("decideTrade: no trade inside the fee band, buys the cheap side outside it", () => {
  const s = pool();
  assert.strictEqual(decideTrade({ s, pModel: s.price + 0.03 }).reason, "inside-band");
  const up = decideTrade({ s, pModel: s.price + 0.12 });
  assert.strictEqual(up.action, "trade"); assert.strictEqual(up.dir, "usdcToYes");
  const dn = decideTrade({ s, pModel: s.price - 0.12 });
  assert.strictEqual(dn.action, "trade"); assert.strictEqual(dn.side, "no");
  for (const d of [up, dn]) assert.ok(d.evMicro > 0 && d.fee === Math.floor(d.amountIn * FEE));
});

test("decideTrade re-centres toward the model but never past it (stops fee+margin short)", () => {
  const s = pool(), pModel = s.price + 0.10;
  const d = decideTrade({ s, pModel, cfg: { maxTradeUsdc: 1000, maxMarketUsdc: 1000 } });
  assert.ok(d.ammAfterEst > s.price && d.ammAfterEst <= pModel, `${s.price} -> ${d.ammAfterEst} (model ${pModel})`);
  assert.ok(Math.abs(d.ammAfterEst - (pModel - FEE - 0.005)) < 0.002, `${d.ammAfterEst}`);
});

test("decideTrade caps: per trade, per market inventory, budget, near-expiry, closed", () => {
  const s = pool(), pModel = s.price + 0.3;
  assert.strictEqual(decideTrade({ s, pModel, cfg: { maxTradeUsdc: 2 } }).amountIn, 2e6);
  assert.strictEqual(decideTrade({ s, pModel, held: 60e6 }).reason, "inventory-cap");
  assert.strictEqual(decideTrade({ s, pModel, budget: 0.5e6 }).reason, "budget");
  assert.strictEqual(decideTrade({ s: { ...s, secondsLeft: 100 }, pModel }).reason, "near-expiry");
  assert.strictEqual(decideTrade({ s: { ...s, resolved: true }, pModel }).reason, "closed");
  assert.strictEqual(decideTrade({ s, pModel: 1 }).reason, "model-degenerate");
});

const T = (o) => ({ market: "M1", name: "SOL>95@1", asset: "SOL", side: "no", amountIn: 3e6, quotedOut: 4e6, fee: 60000, pModel: 0.2, ammBefore: 0.27, ammAfter: 0.22, evMicro: 200000, signature: "sig", at: 10, ...o });
test("tradeStats: counts only signed, non-dry trades; LP gets half the fee", () => {
  const st = tradeStats([T(), T({ market: "M2", side: "yes", at: 20 }), T({ signature: null }), T({ dry: true })]);
  assert.strictEqual(st.trades, 2); assert.strictEqual(st.volumeUsdc, 6); assert.strictEqual(st.feesUsdc, 0.12); assert.strictEqual(st.lpFeesUsdc, 0.06);
  assert.strictEqual(st.markets, 2); assert.strictEqual(st.yes, 1); assert.strictEqual(st.meanGapClosed, 0.05); assert.strictEqual(st.firstAt, 10); assert.strictEqual(st.lastAt, 20);
  assert.strictEqual(tradeStats([]).meanGapClosed, null);
});

test("resolution log + dashboard carry trades and traction stats", () => {
  const created = [{ market: "M1", name: "SOL>95@1", fairYes: 0.27, marketId: 1 }];
  const resolved = [{ market: "M1", name: "SOL>95@1", asset: "SOL", strike: 95, endTs: 1, side: "no", oraclePrice: 94, oracleTs: 3, oracleSource: "pyth-onchain x", signature: "r" }];
  const log = buildResolutionLog({ created, resolved, trades: [T(), T({ market: "M9", at: 30 })], generatedAt: 50 });
  assert.strictEqual(log.stats.traction.trades, 2);
  assert.strictEqual(log.trades[0].market, "M9"); assert.strictEqual(log.trades[0].outcome, null);
  assert.strictEqual(log.trades[1].outcome, "no"); assert.strictEqual(log.trades[1].amountUsdc, 3);
  const html = renderSite(log);
  assert.match(html, /Traction: edge re-centering trader/); assert.match(html, /<b>2<\/b>trades/); assert.match(html, /<b>6\.00<\/b>volume/);
  assert.match(renderSite(buildResolutionLog({ created, resolved })), /No trades yet/);
});
