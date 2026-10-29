// Fair value for "Will ASSET be above STRIKE at EXPIRY?" markets.
// Under lognormal (GBM) price dynamics the YES token is a cash-or-nothing digital:
//   P(YES) = Phi(d2),  d2 = [ln(S/K) - sigma^2 tau / 2] / (sigma sqrt(tau))
// This is exactly the "Gaussian score" model the pm-AMM is built for (score = ln S - ln K).
const { capitalPhi, phiInv, poolValue, priceFromReserves } = require("@pm-amm/sdk/math");

const YEAR_SECS = 365 * 24 * 3600;

function digitalAboveProb({ spot, strike, sigmaAnnual, secsToExpiry }) {
  if (!(spot > 0 && strike > 0)) throw new Error("spot and strike must be > 0");
  if (secsToExpiry <= 0) return spot > strike ? 1 : 0;
  const tau = secsToExpiry / YEAR_SECS;
  const sd = sigmaAnnual * Math.sqrt(tau);
  if (sd <= 0) return spot > strike ? 1 : 0;
  const d2 = (Math.log(spot / strike) - (sd * sd) / 2) / sd;
  return capitalPhi(d2);
}

// Annualised realised vol from a series of close prices sampled every `stepSecs`.
function realizedVol(closes, stepSecs) {
  if (closes.length < 3) throw new Error("need >= 3 closes");
  const r = [];
  for (let i = 1; i < closes.length; i++) r.push(Math.log(closes[i] / closes[i - 1]));
  const m = r.reduce((a, b) => a + b, 0) / r.length;
  const v = r.reduce((a, b) => a + (b - m) ** 2, 0) / (r.length - 1);
  return Math.sqrt(v * (YEAR_SECS / stepSecs));
}

// Edge of a pm-AMM market vs fair value, in probability points (positive = YES cheap).
function edge(fairYes, marketYes) { return fairYes - marketYes; }

// Strike that a market should be seeded at for a target initial probability.
function strikeForProb({ spot, sigmaAnnual, secsToExpiry, prob }) {
  const sd = sigmaAnnual * Math.sqrt(secsToExpiry / YEAR_SECS);
  return spot * Math.exp(-(phiInv(prob) * sd) - (sd * sd) / 2);
}

module.exports = { digitalAboveProb, realizedVol, edge, strikeForProb, poolValue, priceFromReserves, YEAR_SECS };
