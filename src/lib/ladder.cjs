// Strike-ladder planner (pure, no I/O). Given spot + vol + expiry, pick strikes at target
// probabilities, round them to a readable tick, then re-price each rounded strike so the
// pm-AMM market is seeded exactly at fair value (initialPriceBps).
const { digitalAboveProb, strikeForProb } = require("./pricing.cjs");

const TICKS = { SOL: 0.5, BTC: 100, ETH: 5 };
const DEFAULT_PROBS = [0.1, 0.25, 0.5, 0.75, 0.9];

function roundTick(x, tick) { const d = Math.max(0, -Math.floor(Math.log10(tick)) + 1); return +(Math.round(x / tick) * tick).toFixed(d); }
const strikeName = (asset, strike, endTs) => `${asset}>${strike}@${endTs}`;

// Largest "nice" tick (1/2/5 x 10^k) that is <= 1/5 of the 1-sigma move, capped at the asset default.
function autoTick(spot, sigmaAnnual, secs, cap = Infinity) {
  const move = spot * sigmaAnnual * Math.sqrt(secs / (365 * 24 * 3600)) / 5;
  if (!(move > 0)) return cap === Infinity ? 1 : cap;
  const k = Math.floor(Math.log10(move));
  const t = [5, 2, 1].map((m) => m * 10 ** k).find((x) => x <= move);
  return Math.min(cap, +t.toPrecision(1));
}

function planLadder({ asset, spot, sigmaAnnual, endTs, nowTs = Math.floor(Date.now() / 1000), probs = DEFAULT_PROBS, tick }) {
  const secs = endTs - nowTs;
  if (secs < 300) throw new Error("pm-AMM markets must last >= 300 s");
  if (!tick) tick = autoTick(spot, sigmaAnnual, secs, TICKS[asset] || 1);
  const seen = new Set();
  const rungs = [];
  for (const prob of probs) {
    const strike = roundTick(strikeForProb({ spot, sigmaAnnual, secsToExpiry: secs, prob }), tick);
    if (seen.has(strike)) continue; // tiny vol/short expiry can collapse rungs onto one tick
    seen.add(strike);
    const fair = digitalAboveProb({ spot, strike, sigmaAnnual, secsToExpiry: secs });
    const initialPriceBps = Math.min(9900, Math.max(100, Math.round(fair * 10_000)));
    const name = strikeName(asset, strike, endTs);
    if (Buffer.byteLength(name) > 64) throw new Error("name > 64 bytes");
    rungs.push({ asset, strike, endTs, targetProb: prob, fairYes: fair, initialPriceBps, name });
  }
  return rungs;
}

// Next expiry aligned to a UTC grid (e.g. every 6h at 00/06/12/18 UTC), at least minSecs away.
function nextExpiry(nowTs, gridSecs = 6 * 3600, minSecs = 3600) {
  let t = Math.ceil(nowTs / gridSecs) * gridSecs;
  while (t - nowTs < minSecs) t += gridSecs;
  return t;
}

module.exports = { autoTick, planLadder, nextExpiry, roundTick, strikeName, TICKS, DEFAULT_PROBS };
