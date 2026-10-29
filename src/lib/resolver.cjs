// Oracle resolution adapter (dry-run). Decides YES/NO for a strike market from Pyth
// at endTs. Signing resolveMarket on-chain is deliberately NOT wired here yet.
const { pythAt } = require("./feeds.cjs");

// Market name convention: "SOL>150@1764950400" (asset, strike, unix expiry)
function parseStrikeName(name) {
  const m = /^([A-Z]{2,5})>([0-9.]+)@([0-9]{9,11})$/.exec(name.trim());
  if (!m) return null;
  return { asset: m[1], strike: Number(m[2]), endTs: Number(m[3]) };
}

async function decide(name, nowTs = Math.floor(Date.now() / 1000)) {
  const s = parseStrikeName(name);
  if (!s) return { status: "not-a-strike-market" };
  if (nowTs < s.endTs) return { status: "not-expired", ...s };
  const px = await pythAt(s.asset, s.endTs);
  return { status: "decided", side: px.price > s.strike ? "yes" : "no", oraclePrice: px.price, oracleTs: px.publishTime, ...s };
}

module.exports = { parseStrikeName, decide };
