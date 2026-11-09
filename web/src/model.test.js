import { describe, it, expect } from "vitest";
import { normCdf, digitalAboveProb, modelYes, quotePreview, suggestedSide, groupLadders, fmtLeft } from "./model.js";

describe("model", () => {
  it("normCdf matches known values", () => {
    expect(normCdf(0)).toBeCloseTo(0.5, 7);
    expect(normCdf(1.96)).toBeCloseTo(0.975, 3);
    expect(normCdf(-1)).toBeCloseTo(0.158655, 5);
  });
  it("digital: ATM just under 0.5, expiry collapses to 0/1", () => {
    const p = digitalAboveProb({ spot: 100, strike: 100, sigmaAnnual: 0.6, secsToExpiry: 6 * 3600 });
    expect(p).toBeLessThan(0.5); expect(p).toBeGreaterThan(0.49);
    expect(digitalAboveProb({ spot: 101, strike: 100, sigmaAnnual: 0.6, secsToExpiry: 0 })).toBe(1);
    expect(digitalAboveProb({ spot: 0, strike: 100, sigmaAnnual: 0.6, secsToExpiry: 10 })).toBeNull();
  });
  it("matches the keeper's seed fair value for a real logged market", () => {
    // BTC>74700@1794247200 seeded at fairYes 0.51695 from spot 74737.97, sigma 0.42745, created 1794227716
    const p = digitalAboveProb({ spot: 74737.97, strike: 74700, sigmaAnnual: 0.4274530054824949, secsToExpiry: 1794247200 - 1794227685 });
    expect(p).toBeCloseTo(0.51695, 3);
  });
  it("modelYes prefers the latest trade spot, honours an override", () => {
    const m = { strike: 100, endTs: 3600, seed: { spot: 90, sigmaAnnual: 0.5 }, amm: { spot: 110, sigmaAnnual: 0.5 } };
    expect(modelYes(m, 0)).toBeGreaterThan(0.5);
    expect(modelYes(m, 0, 90)).toBeLessThan(0.5);
  });
  it("quotePreview: fee, tokens, EV sign", () => {
    const q = quotePreview({ side: "yes", amountUsdc: 10, ammYes: 0.4, pYes: 0.5 });
    expect(q.fee).toBeCloseTo(0.2); expect(q.tokens).toBeCloseTo(24.5); expect(q.ev).toBeCloseTo(2.25); expect(q.edgePts).toBeCloseTo(10);
    const n = quotePreview({ side: "no", amountUsdc: 10, ammYes: 0.4, pYes: 0.5 });
    expect(n.price).toBeCloseTo(0.6); expect(n.ev).toBeLessThan(0);
    expect(quotePreview({ side: "yes", amountUsdc: 0, ammYes: 0.4, pYes: 0.5 })).toBeNull();
    expect(quotePreview({ side: "yes", amountUsdc: 5, ammYes: 1, pYes: 0.5 })).toBeNull();
  });
  it("suggestedSide uses fee + 3pt band", () => {
    expect(suggestedSide(0.5, 0.46)).toBeNull();
    expect(suggestedSide(0.6, 0.5)).toBe("yes");
    expect(suggestedSide(0.3, 0.4)).toBe("no");
  });
  it("groupLadders filters by asset and sorts", () => {
    const open = [
      { asset: "SOL", endTs: 200, strike: 90 }, { asset: "SOL", endTs: 200, strike: 95 }, { asset: "BTC", endTs: 100, strike: 70000 },
    ];
    const g = groupLadders(open);
    expect(g.map((l) => l.asset)).toEqual(["BTC", "SOL"]);
    expect(g[1].rungs.map((r) => r.strike)).toEqual([95, 90]);
    expect(groupLadders(open, "SOL")).toHaveLength(1);
  });
  it("fmtLeft", () => { expect(fmtLeft(3 * 3600 + 120)).toBe("3h 2m"); expect(fmtLeft(-1)).toBe("expired"); });
});
