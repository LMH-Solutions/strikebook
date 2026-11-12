// Edge re-centering trader (pure). For each open ladder rung, compute a model probability for YES from the
// live Pyth spot + realised vol (lognormal digital, Phi(d2)), compare to the pm-AMM price, and if the gap beats
// the 2% swap fee plus a margin, buy the cheap side just enough to move the AMM price back toward the model
// (never past it), capped by a per-trade size, a per-market inventory cap and the wallet budget.
// Everything here is deterministic and unit-tested; src/trader.cjs does the I/O (Pyth, RPC, signing, logs).
const { capitalPhi } = require("@pm-amm/sdk/math");
const { digitalAboveProb } = require("./pricing.cjs");
const { quoteSwapState, FEE_BPS, xFromY, yFromX } = require("./pmamm.cjs");

const FEE = FEE_BPS / 10_000;
const DEFAULTS = { minEdge: 0.03, margin: 0.005, maxTradeUsdc: 20, minTradeUsdc: 1, maxMarketUsdc: 60, minSecsLeft: 300, budgetUsdc: 200 };

// After a USDC->YES swap with net input d the pool is (x', y') = (xFromY(y+d), y+d); after USDC->NO, (x+d, yFromX(x+d)).
// Price = Phi((y'-x')/L). xFromY / yFromX are the same inverse-curve solvers pmamm.cjs uses for exact quotes.
// Pool state after buying with `amountIn` micro-USDC (fee taken on input, like quoteSwapState).
function stateAfterBuy(s, dir, amountIn) {
  const d = amountIn - Math.floor((amountIn * FEE_BPS) / 10_000);
  let x, y;
  if (dir === "usdcToYes") { y = s.y + d; x = xFromY(y, s.lEff); } else { x = s.x + d; y = yFromX(x, s.lEff); }
  return { ...s, x, y, price: capitalPhi((y - x) / s.lEff) };
}

// Model probability that ASSET > strike at endTs.
function modelProb({ spot, strike, sigmaAnnual, endTs, now }) {
  return digitalAboveProb({ spot, strike, sigmaAnnual, secsToExpiry: Math.max(endTs - now, 0) });
}

// Decide one trade for one market. s = pmamm.marketState(...) (x, y, lEff, price, secondsLeft, resolved, expired).
// held = micro-USDC already spent by the trader on this market. Returns { action:"trade", dir, amountIn, ... } or { action:"skip", reason }.
function decideTrade({ s, pModel, held = 0, budget = Infinity, cfg = {} }) {
  const c = { ...DEFAULTS, ...cfg };
  if (s.resolved || s.expired) return { action: "skip", reason: "closed" };
  if (s.secondsLeft < c.minSecsLeft) return { action: "skip", reason: "near-expiry" };
  if (!(pModel > 0 && pModel < 1)) return { action: "skip", reason: "model-degenerate" };
  const gap = pModel - s.price; // >0: YES cheap
  const need = c.minEdge + FEE; // the fee is paid on every buy, so only a gap well above it is worth trading
  if (Math.abs(gap) < need) return { action: "skip", reason: "inside-band", gap };
  const dir = gap > 0 ? "usdcToYes" : "usdcToNo";
  // Re-centre to the edge of the no-trade band (model -/+ fee+margin), not all the way: the last bit of edge doesn't pay the fee.
  const band = FEE + c.margin;
  const target = gap > 0 ? pModel - band : pModel + band;
  const cap = Math.floor(Math.min(c.maxTradeUsdc * 1e6, c.maxMarketUsdc * 1e6 - held, budget));
  if (cap < c.minTradeUsdc * 1e6) return { action: "skip", reason: held > 0 && c.maxMarketUsdc * 1e6 - held < c.minTradeUsdc * 1e6 ? "inventory-cap" : "budget", gap };
  const reached = (amt) => { const p = stateAfterBuy(s, dir, amt).price; return gap > 0 ? p >= target : p <= target; };
  let amountIn;
  if (!reached(cap)) amountIn = cap; // cap binds: trade the cap, price moves partway
  else {
    let lo = 0, hi = cap;
    for (let i = 0; i < 60 && hi - lo > 1000; i++) { const mid = Math.floor((lo + hi) / 2); if (reached(mid)) hi = mid; else lo = mid; }
    amountIn = Math.floor(hi / 1000) * 1000; // round to 0.001 USDC
  }
  if (amountIn < c.minTradeUsdc * 1e6) return { action: "skip", reason: "too-small", gap };
  const q = quoteSwapState(s, dir, amountIn);
  const pSide = dir === "usdcToYes" ? pModel : 1 - pModel;
  const ev = q.out * pSide - amountIn; // expected payoff (1 USDC per winning token) minus cost, micro-USDC
  if (ev <= 0) return { action: "skip", reason: "negative-ev", gap };
  const after = stateAfterBuy(s, dir, amountIn).price;
  return { action: "trade", dir, side: dir === "usdcToYes" ? "yes" : "no", amountIn, quotedOut: q.out, fee: q.fee, avgPrice: amountIn / q.out,
    ammBefore: s.price, ammAfterEst: after, pModel, gap, evMicro: Math.round(ev) };
}

// Exit rule (pure; src/trader.cjs signs the sell via yesToUsdc/noToUsdc after planExit sizes it on the exact quote). Holding `tokens` (micro) of `side`, sell when the
// AMM bid for that side, net of the fee, beats the model's expected payoff by `margin`. Proceeds use a linear marginal-price estimate, so
// only `maxFraction` of inventory is sold per pass (price impact makes larger sells worse than the estimate).
function decideExit({ s, pModel, side, tokens, cfg = {} }) {
  const c = { ...DEFAULTS, maxFraction: 0.5, ...cfg };
  if (s.resolved || s.expired) return { action: "hold", reason: "closed" };
  if (!(tokens > 0)) return { action: "hold", reason: "no-inventory" };
  if (!(pModel > 0 && pModel < 1)) return { action: "hold", reason: "model-degenerate" };
  const pSide = side === "yes" ? pModel : 1 - pModel;
  const bid = (side === "yes" ? s.price : 1 - s.price) * (1 - FEE);
  const edge = bid - pSide;
  if (edge < c.margin + 0.01) return { action: "hold", reason: "no-exit-edge", edge };
  const amount = Math.floor(tokens * c.maxFraction);
  const estProceeds = Math.floor(amount * bid);
  if (estProceeds < c.minTradeUsdc * 1e6) return { action: "hold", reason: "too-small", edge };
  return { action: "sell", side, dir: side === "yes" ? "yesToUsdc" : "noToUsdc", amount, estProceeds, edge, pModel, ammBefore: s.price };
}

// YES price after selling `tokensIn` raw `side` tokens (same z' = (y - x -/+ d)/L as web/src/amm.js priceAfterSell, clamped like the curve).
const Z_CLAMP = 5.9;
function priceAfterSell(s, side, tokensIn) {
  const z = (s.y - s.x + (side === "yes" ? -tokensIn : tokensIn)) / s.lEff;
  return capitalPhi(Math.max(-Z_CLAMP, Math.min(Z_CLAMP, z)));
}

// Exact-quote exit plan: start from decideExit's size, price it with the exact pm-AMM sell quote (2% fee on the USDC output).
// If price impact pushes the realised average price per token below the model's hold value + `margin`, bisect down to the
// largest size that still clears it (the average sell price falls monotonically with size), then require the proceeds to
// clear minTradeUsdc. Returns decideExit's sell decision plus quotedOut / fee / avgPrice / evMicro / ammAfterEst.
function planExit({ s, pModel, side, tokens, cfg = {} }) {
  const c = { ...DEFAULTS, ...cfg };
  const d = decideExit({ s, pModel, side, tokens, cfg });
  if (d.action !== "sell") return d;
  const pSide = side === "yes" ? pModel : 1 - pModel;
  const ok = (amt) => { const q = quoteSwapState(s, d.dir, amt); return q.out / amt - pSide >= c.margin; };
  let amount = d.amount;
  if (!ok(amount)) {
    let lo = 0, hi = amount;
    for (let i = 0; i < 60 && hi - lo > 1000; i++) { const mid = Math.floor((lo + hi) / 2); if (ok(mid)) lo = mid; else hi = mid; }
    amount = Math.floor(lo / 1000) * 1000; // round to 0.001 token
    if (!(amount > 0)) return { action: "hold", reason: "impact", edge: d.edge };
  }
  const q = quoteSwapState(s, d.dir, amount);
  if (q.out < c.minTradeUsdc * 1e6) return { action: "hold", reason: "too-small", edge: d.edge };
  return { ...d, amount, quotedOut: q.out, fee: q.fee, avgPrice: q.out / amount, evMicro: Math.round(q.out - amount * pSide), ammAfterEst: priceAfterSell(s, side, amount) };
}

// USDC notional of one trades.jsonl record: buys spend amountIn mUSDC; sells (action "sell") receive quotedOut mUSDC for amountIn tokens.
const usdcOf = (t) => (t.action === "sell" ? t.quotedOut || 0 : t.amountIn);

// Traction stats for the dashboard from data/trades.jsonl records.
function tradeStats(trades) {
  const real = trades.filter((t) => t.signature && !t.dry);
  const sum = (f) => real.reduce((a, t) => a + f(t), 0);
  const volume = sum(usdcOf) / 1e6, fees = sum((t) => t.fee) / 1e6;
  const markets = new Set(real.map((t) => t.market));
  const gapClosed = real.filter((t) => Number.isFinite(t.ammAfter)).map((t) => Math.abs(t.pModel - t.ammBefore) - Math.abs(t.pModel - t.ammAfter));
  return { trades: real.length, volumeUsdc: +volume.toFixed(6), feesUsdc: +fees.toFixed(6), lpFeesUsdc: +(fees / 2).toFixed(6), markets: markets.size,
    yes: real.filter((t) => t.side === "yes").length, no: real.filter((t) => t.side === "no").length, sells: real.filter((t) => t.action === "sell").length,
    meanGapClosed: gapClosed.length ? +(gapClosed.reduce((a, b) => a + b, 0) / gapClosed.length).toFixed(4) : null,
    expectedEdgeUsdc: +(sum((t) => t.evMicro || 0) / 1e6).toFixed(6),
    firstAt: real.length ? Math.min(...real.map((t) => t.at)) : null, lastAt: real.length ? Math.max(...real.map((t) => t.at)) : null };
}

module.exports = { decideTrade, decideExit, planExit, priceAfterSell, usdcOf, modelProb, stateAfterBuy, tradeStats, DEFAULTS, FEE };
