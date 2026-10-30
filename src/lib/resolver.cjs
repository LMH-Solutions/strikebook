// Oracle resolution adapter (dry-run). Decides YES/NO for a strike market from Pyth
// at endTs. Pure decision logic; the keeper (src/keeper.cjs) signs resolveMarket on devnet.
const { pythAt } = require("./feeds.cjs");

// Market name convention: "SOL>150@1764950400" (asset, strike, unix expiry)
function parseStrikeName(name) {
  const m = /^([A-Z]{2,5})>([0-9.]+)@([0-9]{9,11})$/.exec(name.trim());
  if (!m) return null;
  return { asset: m[1], strike: Number(m[2]), endTs: Number(m[3]) };
}

// Settlement rule (published for traders): YES iff oracle price at the name's expiry is STRICTLY above
// the strike. The market can only be resolved once BOTH the name expiry and the on-chain endTs passed.
function sideFor(price, strike) { return price > strike ? "yes" : "no"; }

async function decide(name, nowTs = Math.floor(Date.now() / 1000), { onchainEndTs, priceAt = pythAt } = {}) {
  const s = parseStrikeName(name);
  if (!s) return { status: "not-a-strike-market" };
  const lockTs = Math.max(s.endTs, onchainEndTs || 0);
  if (nowTs < lockTs) return { status: "not-expired", secondsLeft: lockTs - nowTs, ...s };
  const px = await priceAt(s.asset, s.endTs, nowTs);
  return { status: "decided", side: sideFor(px.price, s.strike), oraclePrice: px.price, oracleConf: px.conf ?? null,
    oracleTs: px.publishTime, oracleSource: px.source, ...s };
}

module.exports = { parseStrikeName, decide, sideFor };
