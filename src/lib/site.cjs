// Static dashboard renderer (pure). Turns data/resolution-log.json into a single self-contained HTML page
// (no JS, no server, no API keys) so it can be hosted for free on GitHub Pages / Vercel / any static host.
const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const pct = (v) => (v == null ? "–" : (v * 100).toFixed(1) + "%");
const iso = (t) => (t ? new Date(t * 1000).toISOString().replace(".000Z", "Z") : "–");
const tx = (sig, cluster) => (sig ? `<a href="https://solscan.io/tx/${esc(sig)}?cluster=${esc(cluster)}">${esc(sig.slice(0, 8))}…</a>` : "–");
const money = (v, asset) => (v == null ? "–" : "$" + Number(v).toFixed(asset === "BTC" ? 2 : 4));

function renderSite(log) {
  const s = log.stats, cl = log.cluster || "devnet";
  const byMarket = new Map(log.resolutions.map((r) => [r.market, r]));
  const ladders = log.ladders.map((L) => {
    const rows = L.rungs.map((m) => byMarket.get(m)).sort((a, b) => b.strike - a.strike).map((r) => `<tr>
<td>${r.url ? `<a href="${esc(r.url)}">${esc(r.name)}</a>` : esc(r.name)}</td><td>${money(r.strike, r.asset)}</td><td>${pct(r.seed.fairYes)}</td>
<td class="${r.side}">${esc(r.side.toUpperCase())}</td><td>${r.brier == null ? "–" : r.brier.toFixed(3)}</td><td>${tx(r.seed.createTx, cl)}</td><td>${tx(r.resolveTx, cl)}</td><td>${r.claims.length}</td></tr>`).join("");
    const r0 = byMarket.get(L.rungs[0]);
    return `<section><h3>${esc(L.asset)} · expiry ${iso(L.endTs)}</h3>
<p class="proof">Settlement print: <b>${money(L.settlePrice, L.asset)}</b> ± ${r0.oracle.conf == null ? "–" : Number(r0.oracle.conf).toFixed(4)}
at publish_time ${iso(r0.oracle.publishTime)} (${r0.oracle.lagSecs >= 0 ? "+" : ""}${r0.oracle.lagSecs}s after expiry) · source <code>${esc(L.settleSource)}</code></p>
<table><tr><th>Market</th><th>Strike</th><th>Seed fair YES</th><th>Result</th><th>Brier</th><th>Create tx</th><th>Resolve tx</th><th>Claims</th></tr>${rows}</table></section>`;
  }).join("\n");
  const T = s.traction || { trades: 0, volumeUsdc: 0, feesUsdc: 0, lpFeesUsdc: 0, markets: 0 };
  const tradeRows = (log.trades || []).slice(0, 25).map((t) => `<tr><td>${iso(t.at)}</td><td>${esc(t.name)}</td><td class="${esc(t.side)}">BUY ${esc(String(t.side).toUpperCase())}</td>
<td>${Number(t.amountUsdc).toFixed(2)}</td><td>${pct(t.pModel)}</td><td>${pct(t.ammBefore)} → ${pct(t.ammAfter)}</td><td>${Number(t.feeUsdc).toFixed(4)}</td>
<td>${t.outcome ? `<span class="${esc(t.outcome)}">${esc(t.outcome.toUpperCase())}</span>` : "open"}</td><td>${tx(t.tx, cl)}</td></tr>`).join("");
  const traction = `<h2>Traction: edge re-centering trader</h2>
<p><small>A separate devnet trader wallet prices every open rung with the same model (P(YES) = Φ(d2) from the live Pyth spot and 7-day realised vol)
and buys the cheap side when the pm-AMM price is more than fee + 3 pts away, moving the price back toward the model. It pays the real 2% swap fee
(half to the market creator/LP, half to the protocol).</small></p>
<div class="kpi"><div><b>${T.trades}</b>trades</div><div><b>${Number(T.volumeUsdc).toFixed(2)}</b>volume (mUSDC)</div><div><b>${Number(T.feesUsdc).toFixed(3)}</b>swap fees (mUSDC)</div>
<div><b>${Number(T.lpFeesUsdc).toFixed(3)}</b>fees to LP</div><div><b>${T.markets}</b>markets traded</div>
<div><b>${T.meanGapClosed == null ? "–" : (T.meanGapClosed * 100).toFixed(1) + " pts"}</b>mean mispricing closed / trade</div></div>
${tradeRows ? `<table><tr><th>Time (UTC)</th><th>Market</th><th>Side</th><th>mUSDC</th><th>Model YES</th><th>AMM YES before → after</th><th>Fee</th><th>Outcome</th><th>Tx</th></tr>${tradeRows}</table>` : "<p>No trades yet.</p>"}`;
  const cal = s.calibration.filter((b) => b.n).map((b) => `<tr><td>${pct(b.range[0])}–${pct(b.range[1])}</td><td>${b.n}</td><td>${pct(b.meanFair)}</td><td>${pct(b.yesRate)}</td></tr>`).join("");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>StrikeBook: oracle-resolved strike markets on the pm-AMM (${esc(cl)})</title>
<style>body{font:15px/1.45 system-ui,sans-serif;max-width:980px;margin:32px auto;padding:0 16px;color:#111}table{border-collapse:collapse;width:100%;margin:8px 0 20px}
td,th{padding:4px 8px;border-bottom:1px solid #e3e3e3;text-align:left;font-variant-numeric:tabular-nums}.yes{color:#0a7d32;font-weight:600}.no{color:#b3261e;font-weight:600}
.kpi{display:flex;gap:12px;flex-wrap:wrap}.kpi div{border:1px solid #ddd;border-radius:8px;padding:10px 14px;min-width:120px}.kpi b{display:block;font-size:24px}
.proof{color:#444;font-size:13px}code{font-size:12px}small{color:#666}</style></head><body>
<h1>StrikeBook <small>${esc(cl)}</small></h1>
<p><a href="app/"><b>Open markets &amp; trade panel (beta) →</b></a></p>
<p>Short-dated binary strike markets ("Will SOL be above $K at T?") on the Predict pm-AMM, seeded at a fair digital-option price from the
live Pyth mark and realised vol, and <b>resolved by a keeper from the Pyth oracle</b>. Every resolution below carries its oracle proof and devnet transactions.</p>
<p><small>Rule: ${esc(log.rule)}. Program <code>${esc(log.program)}</code>. Log generated ${iso(log.generatedAt)} · schema <code>${esc(log.schema)}</code> ·
<a href="resolution-log.json">raw JSON</a></small></p>
<div class="kpi"><div><b>${s.resolved}</b>markets resolved</div><div><b>${s.ladders}</b>ladders</div><div><b>${s.yes} / ${s.no}</b>YES / NO</div>
<div><b>${s.brier == null ? "–" : s.brier.toFixed(3)}</b>Brier (seed fair)<br><small>coin flip = 0.250</small></div><div><b>${s.openMarkets}</b>open markets</div></div>
${traction}
<h2>Ladders</h2>${ladders || "<p>No resolved markets yet.</p>"}
<h2>Calibration of the pricing engine</h2><p><small>Seed fair YES vs realised YES rate. Small samples are noisy; this fills in as the keeper rolls ladders.</small></p>
<table><tr><th>Seed fair bucket</th><th>n</th><th>Mean fair</th><th>YES rate</th></tr>${cal}</table>
<p><small>Oracle sources: ${esc(Object.entries(s.oracleSources).map(([k, v]) => `${k} × ${v}`).join(", "))}. Devnet test tokens only; no real money.</small></p>
</body></html>
`;
}
module.exports = { renderSite, esc };
