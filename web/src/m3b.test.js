import { describe, it, expect } from "vitest";
import { calibrationPoints, buyBlocker, positionRows, MIN_SOL_FOR_SWAP } from "./model.js";

describe("M3 step 2 pure helpers", () => {
  it("calibrationPoints maps non-empty bins into the SVG box with binomial error bars", () => {
    const bins = [{ range: [0, 0.2], n: 0, meanFair: null, yesRate: null }, { range: [0.4, 0.6], n: 50, meanFair: 0.5, yesRate: 0.38 }, { range: [0.8, 1], n: 4, meanFair: 0.9, yesRate: 1 }];
    const pts = calibrationPoints(bins, 220, 24);
    expect(pts).toHaveLength(2);
    expect(pts[0].cx).toBeCloseTo(24 + 0.5 * 172, 9);
    expect(pts[0].cy).toBeCloseTo(220 - 24 - 0.38 * 172, 9);
    expect(pts[0].y1).toBeLessThan(pts[0].cy); expect(pts[0].y2).toBeGreaterThan(pts[0].cy);
    expect(pts[1].y1).toBeCloseTo(24, 9); // rate 1 -> zero SE, clamped at the top
    expect(calibrationPoints(undefined)).toEqual([]);
  });
  it("buyBlocker explains every disabled state, in order", () => {
    const ok = { hasWallet: true, bal: { sol: 0.2, usdc: 100 }, amountUsdc: 10, quote: {}, busy: false };
    expect(buyBlocker(ok)).toBeNull();
    expect(buyBlocker({ ...ok, busy: true })).toMatch(/sending/);
    expect(buyBlocker({ ...ok, hasWallet: false })).toMatch(/burner/);
    expect(buyBlocker({ ...ok, amountUsdc: 0 })).toMatch(/amount/);
    expect(buyBlocker({ ...ok, bal: null })).toMatch(/balances/);
    expect(buyBlocker({ ...ok, bal: { sol: MIN_SOL_FOR_SWAP / 2, usdc: 100 } })).toMatch(/SOL/);
    expect(buyBlocker({ ...ok, bal: { sol: 1, usdc: 5 } })).toMatch(/mUSDC/);
    expect(buyBlocker({ ...ok, quote: null })).toMatch(/quote/);
  });
  it("positionRows marks open / won / lost and the claimable amount", () => {
    const held = [{ market: "A", name: "a", yes: 3, no: 0 }, { market: "B", name: "b", yes: 0, no: 2 }, { market: "C", name: "c", yes: 1, no: 1 }];
    const rows = positionRows(held, [{ market: "A", side: "yes" }, { market: "B", side: "yes" }]);
    expect(rows.map((r) => [r.market, r.status, r.claimable])).toEqual([["A", "won", 3], ["B", "lost", 0], ["C", "open", 0]]);
  });
});
