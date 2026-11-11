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

// Calibration chart geometry: one point per non-empty bin (x = mean seed fair YES, y = realised YES rate), with a
// ±1.96·SE binomial error bar, mapped into a size×size SVG box with `pad` px margins (y axis pointing up).
export function calibrationPoints(bins = [], size = 220, pad = 24) {
  const span = size - 2 * pad;
  const X = (v) => pad + v * span, Y = (v) => size - pad - v * span;
  return bins.filter((b) => b.n > 0 && b.meanFair != null && b.yesRate != null).map((b) => {
    const se = Math.sqrt((b.yesRate * (1 - b.yesRate)) / b.n);
    const lo = Math.max(0, b.yesRate - 1.96 * se), hi = Math.min(1, b.yesRate + 1.96 * se);
    return { n: b.n, fair: b.meanFair, rate: b.yesRate, cx: X(b.meanFair), cy: Y(b.yesRate), y1: Y(hi), y2: Y(lo), r: Math.min(10, 2 + Math.sqrt(b.n)) };
  });
}

// Why the Buy button is disabled (null = good to go). bal = {sol, usdc} of the burner.
export const MIN_SOL_FOR_SWAP = 0.01; // a first buy in a market opens 1-2 token accounts (~0.002 SOL rent each) + fees
export function buyBlocker({ hasWallet, bal, amountUsdc, quote, busy }) {
  if (busy) return "sending…";
  if (!hasWallet) return "create the devnet burner wallet first";
  if (!(amountUsdc > 0)) return "enter an amount";
  if (!bal) return "loading balances…";
  if (bal.sol < MIN_SOL_FOR_SWAP) return `needs ≥ ${MIN_SOL_FOR_SWAP} devnet SOL for fees/rent: use the faucet`;
  if (bal.usdc < amountUsdc) return "not enough mUSDC: use the faucet";
  if (!quote) return "waiting for the on-chain quote…";
  return null;
}

// Positions view rows: claimable when the market resolved to a side we hold.
export function positionRows(held = [], resolutions = []) {
  const res = new Map(resolutions.map((r) => [r.market, r.side]));
  return held.map((h) => {
    const winner = res.get(h.market) || null;
    const payout = winner === "yes" ? h.yes : winner === "no" ? h.no : 0;
    return { ...h, winner, status: winner ? (payout > 0 ? "won" : "lost") : "open", claimable: payout };
  });
}

// Why a Sell button is disabled (null = good to go). tokens = amount to sell, held = tokens held of that side.
export function sellBlocker({ hasWallet, bal, tokens, held, quote, busy }) {
  if (busy) return "sending…";
  if (!hasWallet) return "create the devnet burner wallet first";
  if (!(tokens > 0)) return "enter an amount";
  if (tokens > held + 1e-9) return "more than you hold";
  if (!bal) return "loading balances…";
  if (bal.sol < 0.002) return "needs a little devnet SOL for fees: use the faucet";
  if (!quote) return "waiting for the on-chain quote…";
  return null;
}

// Overlay live on-chain YES prices ({market: {yes}}) on the keeper-log open markets, keeping the log value as logYes.
export function withLivePrices(open, live) {
  if (!live) return open;
  return open.map((m) => (live[m.market] ? { ...m, amm: { ...m.amm, yes: live[m.market].yes, live: true, logYes: m.amm?.yes ?? null } } : m));
}
