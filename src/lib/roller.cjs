// Ladder roller (pure, no I/O). One keeper "tick" = decide what to resolve and which ladders to (re)create,
// under a devnet-SOL budget. pm-AMM has no close-market instruction, so each market's rent (~0.035 SOL) is spent
// for good: the roller keeps ONE live ladder per asset, rolls it only after it expires, and sizes it to the
// SOL actually in the wallet (center rung first, then the wings).
const { nextExpiry } = require("./ladder.cjs");
const { parseStrikeName } = require("./resolver.cjs");

const RENT_PER_MARKET = 0.036; // devnet SOL spent per createMarket (measured ~0.035 + fees)
const SOL_RESERVE = 0.01;      // keep for resolve/claim tx fees
// Rung priority: the at-the-money market is the most useful single market, then the 25/75 wings, then 10/90.
const PRIORITY = [0.5, 0.25, 0.75, 0.1, 0.9];

function rungProbs(n, probs = PRIORITY) {
  const order = [...probs].sort((a, b) => Math.abs(a - 0.5) - Math.abs(b - 0.5) || a - b);
  return order.slice(0, Math.max(0, n)).sort((a, b) => a - b);
}

// How many rungs each asset needing a ladder can afford. Assets earlier in `assets` win ties.
function allocateRungs({ assets, sol, usdc, deposit, maxRungs, rent = RENT_PER_MARKET, reserve = SOL_RESERVE }) {
  let solLeft = Math.floor(Math.max(0, sol - reserve) / rent + 1e-9);
  let usdcLeft = Math.floor(Math.max(0, usdc) / deposit + 1e-9);
  const out = Object.fromEntries(assets.map((a) => [a, 0]));
  // round-robin so SOL and BTC both get an ATM market before either gets wings
  for (let round = 0; round < maxRungs; round++) {
    for (const a of assets) {
      if (solLeft < 1 || usdcLeft < 1) return out;
      out[a]++; solLeft--; usdcLeft--;
    }
  }
  return out;
}

// Per-rung seed (mUSDC): the target if the wallet covers `rungs` of them, else the even split of the balance, floored at minDeposit.
function affordableDeposit({ usdc, target, minDeposit = Math.min(25, target), rungs }) {
  if (!(rungs > 0) || usdc >= target * rungs) return target;
  return Math.max(Math.min(minDeposit, target), Math.min(target, Math.floor(Math.max(0, usdc) / rungs)));
}

// markets: [{ name, endTs (on-chain), resolved }]  (our wallet's markets only)
// balances: { sol, usdc }
// cfg: { assets, gridSecs, minLeadSecs, maxRungs, minRungs, deposit, minDeposit, probs }
// deposit = target mUSDC seed per rung (M4: 100, deeper pools). If the wallet can't fund a full set of ladders at that depth,
// the seed steps down to what it can afford (never below minDeposit), so depth never costs us rungs.
function planTick({ now, markets, balances, cfg }) {
  const { assets, gridSecs = 6 * 3600, minLeadSecs = 3600, maxRungs = 3, minRungs = 1, deposit: target = 100, minDeposit = 25, probs = PRIORITY } = cfg;
  const strike = markets.map((m) => ({ ...m, s: parseStrikeName(m.name) })).filter((m) => m.s);
  const due = strike.filter((m) => !m.resolved && now >= Math.max(m.s.endTs, m.endTs || 0)).map((m) => m.name);
  const live = strike.filter((m) => !m.resolved && Math.max(m.s.endTs, m.endTs || 0) > now);
  const endTs = nextExpiry(now, gridSecs, minLeadSecs);

  const skipped = [];
  const need = [];
  for (const asset of assets) {
    const mine = live.filter((m) => m.s.asset === asset);
    if (mine.length) { skipped.push({ asset, reason: "live-ladder", until: Math.max(...mine.map((m) => m.s.endTs)) }); continue; }
    need.push(asset);
  }
  const deposit = affordableDeposit({ usdc: balances.usdc, target, minDeposit, rungs: need.length * maxRungs });
  const alloc = allocateRungs({ assets: need, sol: balances.sol, usdc: balances.usdc, deposit, maxRungs });
  const create = [];
  for (const asset of need) {
    const n = alloc[asset];
    if (n < minRungs) { skipped.push({ asset, reason: "low-balance", sol: balances.sol, usdc: balances.usdc, needSol: +(SOL_RESERVE + RENT_PER_MARKET * minRungs).toFixed(3) }); continue; }
    create.push({ asset, endTs, probs: rungProbs(n, probs), deposit });
  }
  const rungsWanted = need.length * maxRungs;
  const rungsPlanned = create.reduce((s, c) => s + c.probs.length, 0);
  return { now, endTs, due, create, skipped, deposit,
    wantsFaucet: rungsPlanned < rungsWanted, // short on SOL/mUSDC for a full ladder: try the hourly faucet
    solNeeded: +(SOL_RESERVE + RENT_PER_MARKET * rungsWanted).toFixed(3) };
}

module.exports = { planTick, allocateRungs, affordableDeposit, rungProbs, RENT_PER_MARKET, SOL_RESERVE, PRIORITY };
