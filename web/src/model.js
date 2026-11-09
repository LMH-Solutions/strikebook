// Pure helpers for the StrikeBook front end (no I/O). Same model as the keeper/trader:
//   P(YES) = Phi(d2),  d2 = [ln(S/K) - sigma^2 tau / 2] / (sigma sqrt(tau))
export const YEAR_SECS = 365 * 24 * 3600;
export const FEE = 0.02; // pm-AMM swap fee (half to LP, half to protocol)

// Standard normal CDF via erf (Abramowitz & Stegun 7.1.26, |err| < 1.5e-7)
export function normCdf(x) {
  const t = 1 / (1 + 0.3275911 * Math.abs(x) / Math.SQRT2);
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-(x * x) / 2);
  return x >= 0 ? (1 + y) / 2 : (1 - y) / 2;
}

export function digitalAboveProb({ spot, strike, sigmaAnnual, secsToExpiry }) {
  if (!(spot > 0 && strike > 0)) return null;
  if (secsToExpiry <= 0) return spot > strike ? 1 : 0;
  const sd = sigmaAnnual * Math.sqrt(secsToExpiry / YEAR_SECS);
  if (!(sd > 0)) return spot > strike ? 1 : 0;
  return normCdf((Math.log(spot / strike) - (sd * sd) / 2) / sd);
}

// Model P(YES) for an open market "now", from the most recent spot/vol the keeper saw (or an override).
export function modelYes(m, nowTs, spotOverride) {
  const spot = spotOverride > 0 ? spotOverride : m.amm?.spot ?? m.seed?.spot;
  const sigma = m.amm?.sigmaAnnual ?? m.seed?.sigmaAnnual;
  if (!(spot > 0 && sigma > 0)) return null;
  return digitalAboveProb({ spot, strike: m.strike, sigmaAnnual: sigma, secsToExpiry: m.endTs - nowTs });
}

// Quote preview for buying `side` with `amountUsdc` at the current AMM price. This is the marginal-price estimate
// (no slippage, so it is an upper bound on tokens); the on-chain swap uses the exact pm-AMM curve.
export function quotePreview({ side, amountUsdc, ammYes, pYes }) {
  const price = side === "yes" ? ammYes : 1 - ammYes;
  const p = pYes == null ? null : side === "yes" ? pYes : 1 - pYes;
  if (!(amountUsdc > 0) || !(price > 0 && price < 1)) return null;
  const fee = amountUsdc * FEE;
  const tokens = (amountUsdc - fee) / price;
  const ev = p == null ? null : p * tokens - amountUsdc; // each winning token pays 1 mUSDC
  return { price, fee, tokens, maxPayout: tokens, ev, evPct: ev == null ? null : ev / amountUsdc, edgePts: p == null ? null : (p - price) * 100 };
}

// Which side the model prefers, if the edge clears fee + band (same rule as the trader: |model - amm| > fee + 3 pts).
export function suggestedSide(pYes, ammYes, band = 0.03) {
  if (pYes == null || ammYes == null) return null;
  const d = pYes - ammYes;
  if (Math.abs(d) <= FEE + band) return null;
  return d > 0 ? "yes" : "no";
}

// Group open markets into ladders (asset + expiry), newest expiry first, strikes descending.
export function groupLadders(open, asset = "ALL") {
  const out = [];
  for (const m of open.filter((x) => asset === "ALL" || x.asset === asset)) {
    let L = out.find((l) => l.asset === m.asset && l.endTs === m.endTs);
    if (!L) out.push((L = { asset: m.asset, endTs: m.endTs, rungs: [] }));
    L.rungs.push(m);
  }
  for (const L of out) L.rungs.sort((a, b) => b.strike - a.strike);
  return out.sort((a, b) => a.endTs - b.endTs || a.asset.localeCompare(b.asset));
}

export function fmtLeft(secs) {
  if (secs <= 0) return "expired";
  const h = Math.floor(secs / 3600), m = Math.floor((secs % 3600) / 60);
  return h ? `${h}h ${m}m` : `${m}m`;
}
export const pct = (v, d = 1) => (v == null ? "–" : (v * 100).toFixed(d) + "%");
export const money = (v, asset) => (v == null ? "–" : "$" + Number(v).toLocaleString("en-US", { maximumFractionDigits: asset === "BTC" ? 0 : 2 }));
