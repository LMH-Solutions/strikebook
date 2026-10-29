#!/usr/bin/env node
// Usage: node src/cli/fair.cjs [ASSET] [STRIKE] [HOURS]
const { pythLatest, hourlyCloses } = require("../lib/feeds.cjs");
const { digitalAboveProb, realizedVol, strikeForProb } = require("../lib/pricing.cjs");

(async () => {
  const asset = (process.argv[2] || "SOL").toUpperCase();
  const hours = Number(process.argv[4] || 24);
  const spot = await pythLatest(asset);
  let sigma = 0.6, volSrc = "default 60%";
  try { sigma = realizedVol(await hourlyCloses(asset), 3600); volSrc = "7d realised (Coinbase 1h)"; } catch (e) { volSrc += ` (${e.message})`; }
  const strike = Number(process.argv[3] || Math.round(spot.price));
  const p = digitalAboveProb({ spot: spot.price, strike, sigmaAnnual: sigma, secsToExpiry: hours * 3600 });
  console.log(JSON.stringify({
    question: `${asset} > $${strike} in ${hours}h?`,
    spot: +spot.price.toFixed(4), spotConf: +spot.conf.toFixed(4), spotSource: spot.source,
    sigmaAnnual: +sigma.toFixed(4), volSource: volSrc,
    fairYes: +p.toFixed(4),
    ladder: [0.1, 0.25, 0.5, 0.75, 0.9].map((q) => ({ prob: q, strike: +strikeForProb({ spot: spot.price, sigmaAnnual: sigma, secsToExpiry: hours * 3600, prob: q }).toFixed(2) })),
  }, null, 2));
})().catch((e) => { console.error(e); process.exit(1); });
