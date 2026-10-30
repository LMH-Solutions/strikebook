#!/usr/bin/env node
// Devnet trade with an exact quote + 1% slippage bound.
// Usage: node src/cli/trade.cjs <marketPda> <usdcToYes|usdcToNo|yesToUsdc|noToUsdc> <amount human units>
const { PublicKey } = require("@solana/web3.js");
const pm = require("../lib/pmamm.cjs");
(async () => {
  const [mkt, dir = "usdcToYes", amt = "5"] = process.argv.slice(2);
  const client = pm.signingClient();
  const market = new PublicKey(mkt);
  const m = await client.fetchMarket(market);
  const amountIn = Math.round(Number(amt) * 1e6);
  const before = pm.marketState(m);
  const q = pm.quoteSwap(m, dir, amountIn);
  const sig = await client.send.swap(market, dir, amountIn, pm.minOutput(q));
  const after = pm.marketState(await client.fetchMarket(market));
  console.log(JSON.stringify({ market: mkt, name: pm.decodeName(m.name), dir, amountIn, quotedOut: q.out, fee: q.fee,
    yesBefore: +before.price.toFixed(4), yesAfter: +after.price.toFixed(4), signature: sig }, null, 2));
})().catch((e) => { console.error(e.message || e); process.exit(1); });
