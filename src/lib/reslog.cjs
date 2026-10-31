// Resolution log builder (pure). Joins our creation log (markets.jsonl: seed fair value, spot, vol) with the
// resolution log (resolutions.jsonl: oracle proof + resolveMarket tx) into ONE static JSON the public dashboard
// reads. Also scores the pricing engine: Brier score of the seed fair price vs outcome, and calibration buckets.
const SCHEMA = "strikebook.resolution-log/v1";

function buildResolutionLog({ created = [], resolved = [], claims = [], generatedAt = Math.floor(Date.now() / 1000), cluster = "devnet", program, app }) {
  const byMarket = new Map(created.map((c) => [c.market, c]));
  const seen = new Set();
  const rows = [];
  for (const r of resolved) {
    if (r.dry || seen.has(r.market)) continue; // first real resolution wins; dry runs never count
    seen.add(r.market);
    const c = byMarket.get(r.market) || {};
    const outcome = r.side === "yes" ? 1 : 0;
    const fair = Number.isFinite(c.fairYes) ? c.fairYes : null;
    rows.push({
      market: r.market, marketId: r.marketId ?? c.marketId ?? null, name: r.name, asset: r.asset, strike: r.strike, endTs: r.endTs,
      seed: { fairYes: fair, initialPriceBps: c.initialPriceBps ?? null, spot: c.spot ?? null, sigmaAnnual: c.sigmaAnnual ?? null, createdAt: c.createdAt ?? null, createTx: c.signature ?? null },
      side: r.side, oracle: { price: r.oraclePrice, conf: r.oracleConf ?? null, publishTime: r.oracleTs, source: r.oracleSource, lagSecs: r.oracleTs - r.endTs },
      resolveTx: r.signature, resolvedAt: r.resolvedAt,
      claims: claims.filter((k) => k.market === r.market && k.signature).map((k) => ({ kind: k.kind, tx: k.signature })),
      url: app && (r.marketId ?? c.marketId) ? `${app}/market/${r.marketId ?? c.marketId}` : null,
      brier: fair == null ? null : +((fair - outcome) ** 2).toFixed(6),
    });
  }
  rows.sort((a, b) => b.endTs - a.endTs || b.strike - a.strike);

  // ladders = (asset, expiry) groups, newest first
  const ladders = [];
  for (const r of rows) {
    let L = ladders.find((l) => l.asset === r.asset && l.endTs === r.endTs);
    if (!L) ladders.push((L = { asset: r.asset, endTs: r.endTs, settlePrice: r.oracle.price, settleSource: r.oracle.source, rungs: [] }));
    L.rungs.push(r.market);
  }

  const scored = rows.filter((r) => r.brier != null);
  const brier = scored.length ? scored.reduce((s, r) => s + r.brier, 0) / scored.length : null;
  const buckets = [[0, 0.2], [0.2, 0.4], [0.4, 0.6], [0.6, 0.8], [0.8, 1.0001]].map(([lo, hi]) => {
    const b = scored.filter((r) => r.seed.fairYes >= lo && r.seed.fairYes < hi);
    return { range: [lo, Math.min(hi, 1)], n: b.length,
      meanFair: b.length ? +(b.reduce((s, r) => s + r.seed.fairYes, 0) / b.length).toFixed(4) : null,
      yesRate: b.length ? +(b.filter((r) => r.side === "yes").length / b.length).toFixed(4) : null };
  });
  const sources = {};
  for (const r of rows) { const k = r.oracle.source.split(" ")[0]; sources[k] = (sources[k] || 0) + 1; }
  const assets = {};
  for (const r of rows) { assets[r.asset] = assets[r.asset] || { resolved: 0, yes: 0 }; assets[r.asset].resolved++; if (r.side === "yes") assets[r.asset].yes++; }

  return {
    schema: SCHEMA, generatedAt, cluster, program: program || null, app: app || null,
    rule: "YES iff the first Pyth PriceUpdateV2 print with publish_time >= expiry is strictly above the strike",
    stats: { created: created.length, resolved: rows.length, yes: rows.filter((r) => r.side === "yes").length, no: rows.filter((r) => r.side === "no").length,
      ladders: ladders.length, assets, oracleSources: sources,
      brier: brier == null ? null : +brier.toFixed(4), brierCoinFlip: 0.25, calibration: buckets,
      openMarkets: created.filter((c) => !seen.has(c.market)).length },
    ladders, resolutions: rows,
  };
}

module.exports = { buildResolutionLog, SCHEMA };
