import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";
import { marketState, quoteSwapState, exactBuyQuote, exactSellQuote, priceAfterSell, priceAfterBuy, livePrices, minOutput, xFromY, yFromX } from "./amm.js";
import { sellBlocker, withLivePrices } from "./model.js";

const require = createRequire(import.meta.url);
const cjs = require("../../src/lib/pmamm.cjs");
const Q = 2n ** 48n;
const fx = (v) => BigInt(Math.round(v * 2 ** 20)) * (Q / 2n ** 20n);
const NOW = 1_800_000_000, END = NOW + 6 * 3600;
const L0 = 25e6 / Math.sqrt(7 * 3600);
const pdf = (z) => Math.exp(-z * z / 2) / Math.sqrt(2 * Math.PI);
function erf(x) { const t = 1 / (1 + 0.3275911 * Math.abs(x)); const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x); return x >= 0 ? y : -y; }
function pool(z) {
  const L = L0 * Math.sqrt(7 * 3600), Phi = 0.5 * (1 + erf(z / Math.SQRT2));
  const y = L * (z * Phi + pdf(z)), x = y - L * z;
  return { endTs: END, lZero: fx(L0), lastAccrualTs: NOW - 3600, reserveYes: fx(x), reserveNo: fx(y), resolved: false, winningSide: 0 };
}
const Z40 = -0.2533;

describe("M3 step 3: exact sell quote", () => {
  it("sell output equals the CJS yesToUsdc/noToUsdc quote to the base unit", () => {
    const s = marketState(pool(Z40), NOW);
    for (const side of ["yes", "no"]) for (const raw of [1e6, 5e6, 20e6]) {
      const q = exactSellQuote(s, { side, tokensRaw: raw });
      expect(q.outRaw).toBe(cjs.quoteSwapState(s, side === "yes" ? "yesToUsdc" : "noToUsdc", raw).out);
      expect(q.minOutRaw).toBe(minOutput({ out: q.outRaw }, 100));
      expect(q.minOutRaw).toBeLessThan(q.outRaw);
    }
  });
  it("selling YES lowers YES, selling NO raises it; avg price is below the marginal price (slippage + fee)", () => {
    const s = marketState(pool(Z40), NOW);
    const y = exactSellQuote(s, { side: "yes", tokens: 5 }), n = exactSellQuote(s, { side: "no", tokens: 5 });
    expect(y.yesAfter).toBeLessThan(s.price); expect(n.yesAfter).toBeGreaterThan(s.price);
    expect(y.avgPrice).toBeLessThan(y.price); expect(n.avgPrice).toBeLessThan(n.price);
    expect(y.fee).toBeCloseTo(Math.floor(y.outRaw / 0.98 * 0.02) / 1e6, 4);
  });
  it("priceAfterSell is consistent with the curve: sell YES moves the pool to the post-trade z", () => {
    const s = marketState(pool(Z40), NOW), d = 4e6;
    const gross = quoteSwapState({ ...s }, "yesToUsdc", d); // fee is on output, so the pool state uses the gross out
    const out = Math.floor(gross.out / 0.98); // ≈ gross
    const x2 = s.x + d - out, y2 = s.y - out;
    expect(priceAfterSell(s, "yes", d)).toBeCloseTo(0.5 * (1 + erf(((y2 - x2) / s.lEff) / Math.SQRT2)), 3);
  });
  it("buy then immediately sell the same tokens returns less than paid (fees both ways), never more", () => {
    const s = marketState(pool(Z40), NOW);
    for (const side of ["yes", "no"]) {
      const b = exactBuyQuote(s, { side, amountUsdc: 10 });
      // pool after the buy (net input d = 9.8 mUSDC)
      const d = b.amountIn - Math.floor(b.amountIn * 0.02);
      const [x, y] = side === "yes" ? [xFromY(s.y + d, s.lEff), s.y + d] : [s.x + d, yFromX(s.x + d, s.lEff)];
      const s2 = { ...s, x, y, price: priceAfterBuy(s, side, b.amountIn) };
      const sl = exactSellQuote(s2, { side, tokensRaw: b.outRaw });
      expect(sl.usdc).toBeLessThan(10); expect(sl.usdc).toBeGreaterThan(9.4);
      expect(sl.yesAfter).toBeCloseTo(s.price, 3); // round trip returns the pool to where it was
    }
  });
  it("hold-vs-sell EV under the model, and null on resolved/expired/zero", () => {
    const s = marketState(pool(Z40), NOW);
    const q = exactSellQuote(s, { side: "yes", tokens: 2, pYes: 0.1 });
    expect(q.holdEv).toBeCloseTo(0.2, 9); expect(q.sellEdge).toBeGreaterThan(0);
    expect(exactSellQuote(marketState({ ...pool(Z40), resolved: true, winningSide: 1 }, NOW), { side: "yes", tokens: 1 })).toBeNull();
    expect(exactSellQuote(marketState(pool(Z40), END + 1), { side: "yes", tokens: 1 })).toBeNull();
    expect(exactSellQuote(s, { side: "yes", tokens: 0 })).toBeNull();
    expect(exactSellQuote(null, { side: "yes", tokens: 1 })).toBeNull();
  });
});

describe("M3 step 3: live prices + sell gate", () => {
  it("livePrices decodes each fetched Market account; withLivePrices overrides the keeper-log AMM price", () => {
    const lp = livePrices({ A: pool(Z40), B: null }, NOW);
    expect(Object.keys(lp)).toEqual(["A"]);
    expect(lp.A.yes).toBeCloseTo(marketState(pool(Z40), NOW).price, 12);
    const open = [{ market: "A", amm: { yes: 0.9, trades: 1 } }, { market: "C", amm: { yes: 0.3, trades: 0 } }];
    const merged = withLivePrices(open, lp);
    expect(merged[0].amm.yes).toBeCloseTo(lp.A.yes, 12); expect(merged[0].amm.live).toBe(true); expect(merged[0].amm.logYes).toBe(0.9);
    expect(merged[1]).toBe(open[1]);
    expect(withLivePrices(open, null)).toBe(open);
  });
  it("sellBlocker explains every disabled state", () => {
    const ok = { hasWallet: true, bal: { sol: 0.1, usdc: 0 }, tokens: 3, held: 5, quote: {}, busy: false };
    expect(sellBlocker(ok)).toBeNull();
    expect(sellBlocker({ ...ok, busy: true })).toMatch(/sending/);
    expect(sellBlocker({ ...ok, hasWallet: false })).toMatch(/burner/);
    expect(sellBlocker({ ...ok, tokens: 0 })).toMatch(/amount/);
    expect(sellBlocker({ ...ok, tokens: 6 })).toMatch(/more than you hold/);
    expect(sellBlocker({ ...ok, bal: null })).toMatch(/balances/);
    expect(sellBlocker({ ...ok, bal: { sol: 0.001, usdc: 0 } })).toMatch(/SOL/);
    expect(sellBlocker({ ...ok, quote: null })).toMatch(/quote/);
  });
});

import { renderToString } from "react-dom/server";
import { createElement as h } from "react";
import { MarketsList } from "./App.jsx";
describe("M3 step 3: markets list shows the live price marker", () => {
  it("renders the live dot + timestamp when prices came from the chain", () => {
    const open = withLivePrices([{ market: "M1", name: "SOL>90@2000", asset: "SOL", strike: 90, endTs: 2000, seed: { spot: 90, sigmaAnnual: 0.6 }, amm: { yes: 0.4, trades: 2, spot: 91, sigmaAnnual: 0.6 } }], { M1: { yes: 0.55 } });
    const html = renderToString(h(MarketsList, { open, asset: "ALL", now: 1000, selected: null, onSelect: () => {}, liveAt: 1000 }));
    expect(html).toContain("55.0%"); expect(html).toContain("aria-label=\"live\""); expect(html).toContain("keeper log: 40.0%"); expect(html).toContain("read live");
  });
});
