import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";
import { marketState, quoteSwapState, exactBuyQuote, priceAfterBuy, minOutput } from "./amm.js";
import { quotePreview } from "./model.js";

const require = createRequire(import.meta.url);
const cjs = require("../../src/lib/pmamm.cjs"); // the keeper/trader's exact quote: the browser port must match it
const Q = 2n ** 48n;
const fx = (v) => BigInt(Math.round(v * 2 ** 20)) * (Q / 2n ** 20n); // float -> I80F48 raw bigint
// A 25 mUSDC pool seeded at ~40% YES, 6 h to expiry, last accrued 1 h ago.
const NOW = 1_800_000_000, END = NOW + 6 * 3600;
const L0 = 25e6 / Math.sqrt(7 * 3600); // L_eff ≈ 25 mUSDC at the last accrual
const pdf = (z) => Math.exp(-z * z / 2) / Math.sqrt(2 * Math.PI);
function pool(z) { // on-curve reserves with YES price Phi(z): y = L·(zΦ(z)+φ(z)), x = y − L·z
  const L = L0 * Math.sqrt(7 * 3600), Phi = 0.5 * (1 + erf(z / Math.SQRT2));
  const y = L * (z * Phi + pdf(z)), x = y - L * z;
  return { endTs: END, lZero: fx(L0), lastAccrualTs: NOW - 3600, reserveYes: fx(x), reserveNo: fx(y), resolved: false, winningSide: 0 };
}
function erf(x) { const t = 1 / (1 + 0.3275911 * Math.abs(x)); const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x); return x >= 0 ? y : -y; }
const Z40 = -0.2533; // Phi(Z40) ≈ 0.40

describe("exact pm-AMM quote (browser port)", () => {
  it("marketState matches src/lib/pmamm.cjs", () => {
    const m = pool(Z40);
    const a = marketState(m, NOW), b = cjs.marketState(m, NOW);
    for (const k of ["x", "y", "lEff", "price", "secondsLeft"]) expect(a[k]).toBeCloseTo(b[k], 6);
    expect(a.price).toBeGreaterThan(0.3); expect(a.price).toBeLessThan(0.5);
  });
  it("quoteSwapState matches the CJS quote in every direction, to the base unit", () => {
    const s = marketState(pool(Z40), NOW);
    for (const dir of ["usdcToYes", "usdcToNo", "yesToUsdc", "noToUsdc"])
      for (const amt of [1e6, 10e6, 50e6]) expect(quoteSwapState(s, dir, amt)).toEqual(cjs.quoteSwapState(s, dir, amt));
  });
  it("buying YES gets fewer tokens than the no-slippage estimate and moves the price up", () => {
    const s = marketState(pool(Z40), NOW);
    const q = exactBuyQuote(s, { side: "yes", amountUsdc: 10, pYes: 0.5 });
    const est = quotePreview({ side: "yes", amountUsdc: 10, ammYes: s.price, pYes: 0.5 });
    expect(q.tokens).toBeLessThan(est.tokens);
    expect(q.tokens).toBeGreaterThan(est.tokens * 0.7);
    expect(q.priceAfter).toBeGreaterThan(q.price);
    expect(q.avgPrice).toBeGreaterThan(q.price);
    expect(q.fee).toBeCloseTo(0.2, 6);
    expect(q.minOutRaw).toBe(minOutput({ out: q.outRaw }, 100));
    expect(q.ev).toBeCloseTo(0.5 * q.tokens - 10, 9);
  });
  it("buying NO moves YES down; tiny trades converge to the marginal price", () => {
    const s = marketState(pool(Z40), NOW);
    expect(priceAfterBuy(s, "no", 10e6)).toBeLessThan(s.price);
    const q = exactBuyQuote(s, { side: "no", amountUsdc: 0.01 });
    expect(q.price).toBeCloseTo(1 - s.price, 9);
    expect(0.01 * 0.98 / q.tokens).toBeCloseTo(1 - s.price, 2);
  });
  it("priceAfterBuy agrees with the CJS trader's stateAfterBuy", () => {
    const { stateAfterBuy } = require("../../src/lib/trader.cjs");
    const s = marketState(pool(Z40), NOW);
    for (const side of ["yes", "no"]) expect(priceAfterBuy(s, side, 7e6)).toBeCloseTo(stateAfterBuy(s, side === "yes" ? "usdcToYes" : "usdcToNo", 7e6).price, 6);
  });
  it("no quote on resolved/expired markets or bad amounts", () => {
    expect(exactBuyQuote(marketState({ ...pool(Z40), resolved: true, winningSide: 1 }, NOW), { side: "yes", amountUsdc: 5 })).toBeNull();
    expect(exactBuyQuote(marketState(pool(Z40), END + 1), { side: "yes", amountUsdc: 5 })).toBeNull();
    expect(exactBuyQuote(marketState(pool(Z40), NOW), { side: "yes", amountUsdc: 0 })).toBeNull();
    expect(exactBuyQuote(null, { side: "yes", amountUsdc: 5 })).toBeNull();
  });
});
