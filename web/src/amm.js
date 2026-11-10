// Exact pm-AMM quote in the browser (pure, no I/O). ESM port of src/lib/pmamm.cjs (itself a port of the official
// pm-amm-helpers): time-decayed L_eff = L0 * sqrt(T - t), reserves rescaled to L_eff, inverse-curve solve for the
// output, 2% fee on the USDC input. Amounts are in base units (mUSDC and outcome tokens are 6 dp).
import { capitalPhi, i80f48ToNumber, phi } from "@pm-amm/sdk/math";

export const FEE_BPS = 200;
export const DECIMALS = 6;
const Z_CLAMP = 5.9;
const toNum = (v) => (v && typeof v.toNumber === "function" ? v.toNumber() : Number(v));
const q = (v) => (typeof v === "number" ? v : i80f48ToNumber(v)); // Q64.64 BN/bigint, or an already-decoded float

// Pool state "now" from a decoded Market account (Anchor BN fields) or a plain {endTs, lZero, ...} object.
export function marketState(m, now = Math.floor(Date.now() / 1000)) {
  const endTs = toNum(m.endTs);
  const lZero = q(m.lZero);
  const secondsLeft = Math.max(endTs - now, 0);
  const lEff = lZero * Math.sqrt(Math.max(endTs - now, 1));
  const lLast = lZero * Math.sqrt(Math.max(endTs - toNum(m.lastAccrualTs), 1));
  const scale = lLast > 0 ? lEff / lLast : 0;
  const x = q(m.reserveYes) * scale;
  const y = q(m.reserveNo) * scale;
  const winner = m.winningSide === 1 ? "yes" : m.winningSide === 2 ? "no" : null;
  const price = winner ? (winner === "yes" ? 1 : 0) : lEff > 0 ? capitalPhi((y - x) / lEff) : 0.5;
  return { x, y, lEff, price, secondsLeft, expired: secondsLeft === 0, resolved: !!m.resolved, winner };
}
const base = (u) => u * capitalPhi(u) + phi(u);
function solveU(f, target, increasing) {
  let lo = -40, hi = 40;
  for (let i = 0; i < 200; i++) { const mid = (lo + hi) / 2; const v = f(mid); if (increasing ? v < target : v > target) lo = mid; else hi = mid; }
  return (lo + hi) / 2;
}
export const xFromY = (y, L) => y - L * solveU(base, y / L, true);
export const yFromX = (x, L) => x + solveU((v) => base(v) - v, x / L, false) * L;
function curveOut(s, dir, dIn) {
  const { x, y, lEff: L } = s;
  const clampZ = (z) => Math.max(-Z_CLAMP, Math.min(Z_CLAMP, z));
  switch (dir) {
    case "usdcToYes": return dIn + (x - xFromY(y + dIn, L));
    case "usdcToNo": return dIn + (y - yFromX(x + dIn, L));
    case "yesToUsdc": return y - L * base(clampZ((y - x - dIn) / L));
    case "noToUsdc": { const z = clampZ((y - x + dIn) / L); return x - L * (base(z) - z); }
    default: throw new Error(`bad direction ${dir}`);
  }
}
export function quoteSwapState(s, direction, amountIn) {
  if (s.resolved || s.expired) throw new Error("market is resolved or expired: no swaps");
  const usdcIn = direction === "usdcToYes" || direction === "usdcToNo";
  const usdcOut = direction === "yesToUsdc" || direction === "noToUsdc";
  const feeIn = usdcIn ? Math.floor((amountIn * FEE_BPS) / 10_000) : 0;
  const gross = Math.max(Math.floor(curveOut(s, direction, amountIn - feeIn)), 0);
  const feeOut = usdcOut ? Math.floor((gross * FEE_BPS) / 10_000) : 0;
  const out = gross - feeOut;
  return { out, fee: feeIn + feeOut, avgPrice: amountIn > 0 ? out / amountIn : 0 };
}
export const minOutput = (quote, slippageBps = 100) => Math.floor((quote.out * (10_000 - slippageBps)) / 10_000);

// YES price after buying `side` with net (post-fee) input d: the pool moves to (xFromY(y+d), y+d) or (x+d, yFromX(x+d)).
export function priceAfterBuy(s, side, amountIn) {
  const d = amountIn - Math.floor((amountIn * FEE_BPS) / 10_000);
  const L = s.lEff;
  const [x, y] = side === "yes" ? [xFromY(s.y + d, L), s.y + d] : [s.x + d, yFromX(s.x + d, L)];
  return capitalPhi((y - x) / L);
}

// Full trade-panel quote for "buy `side` with `amountUsdc` mUSDC", replacing the marginal-price estimate.
// pYes = model P(YES) (or null). Returns human units.
export function exactBuyQuote(s, { side, amountUsdc, pYes = null, slippageBps = 100 }) {
  if (!s || !(amountUsdc > 0) || s.resolved || s.expired) return null;
  const amountIn = Math.round(amountUsdc * 10 ** DECIMALS);
  const qt = quoteSwapState(s, side === "yes" ? "usdcToYes" : "usdcToNo", amountIn);
  const tokens = qt.out / 10 ** DECIMALS;
  if (!(tokens > 0)) return null;
  const price = side === "yes" ? s.price : 1 - s.price;
  const yesAfter = priceAfterBuy(s, side, amountIn);
  const priceAfter = side === "yes" ? yesAfter : 1 - yesAfter;
  const avgPrice = amountUsdc / tokens; // all-in cost per token, fee included
  const p = pYes == null ? null : side === "yes" ? pYes : 1 - pYes;
  const ev = p == null ? null : p * tokens - amountUsdc;
  return {
    amountIn, outRaw: qt.out, minOutRaw: minOutput(qt, slippageBps), tokens, fee: qt.fee / 10 ** DECIMALS,
    price, priceAfter, yesAfter, avgPrice, impactPts: (priceAfter - price) * 100, maxPayout: tokens,
    ev, evPct: ev == null ? null : ev / amountUsdc, edgePts: p == null ? null : (p - avgPrice) * 100,
  };
}
