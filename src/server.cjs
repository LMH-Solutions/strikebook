#!/usr/bin/env node
// Minimal local dashboard: GET / (HTML), GET /api/fair?asset=SOL&strike=105&hours=24, GET /api/resolve?name=SOL>100@1793270000
const http = require("http");
const fs = require("fs");
const path = require("path");
const { pythLatest, hourlyCloses } = require("./lib/feeds.cjs");
const { digitalAboveProb, realizedVol, strikeForProb } = require("./lib/pricing.cjs");
const { decide, parseStrikeName } = require("./lib/resolver.cjs");
const pm = require("./lib/pmamm.cjs");

// Live StrikeBook markets (created by our keeper wallet) with fair value vs pm-AMM price.
let mkCache = { t: 0, v: null };
async function strikeMarkets() {
  if (mkCache.v && Date.now() - mkCache.t < 15e3) return mkCache.v; // public devnet RPC rate-limits: poll >= 15 s
  const me = pm.loadKeypair().publicKey;
  const all = await pm.readOnlyClient().fetchAllMarkets(443);
  const now = Math.floor(Date.now() / 1000);
  const spots = {};
  const rows = [];
  for (const { publicKey, account: a } of all) {
    if (!a.authority.equals(me)) continue;
    const name = pm.decodeName(a.name), s = parseStrikeName(name);
    if (!s) continue;
    const st = pm.marketState(a, now);
    let fair = null, spot = null;
    if (!st.resolved && s.endTs > now) {
      spots[s.asset] = spots[s.asset] || (await pythLatest(s.asset)).price;
      spot = spots[s.asset];
      fair = digitalAboveProb({ spot, strike: s.strike, sigmaAnnual: await sigmaFor(s.asset), secsToExpiry: s.endTs - now });
    }
    rows.push({ market: publicKey.toBase58(), marketId: pm.toNum(a.marketId), url: `${pm.APP}/market/${pm.toNum(a.marketId)}`, name, ...s,
      secondsLeft: Math.max(s.endTs - now, 0), yes: st.price, fair, edge: fair == null ? null : fair - st.price, spot, resolved: st.resolved, winner: st.winner });
  }
  rows.sort((x, y) => y.endTs - x.endTs || y.strike - x.strike);
  mkCache = { t: Date.now(), v: { wallet: me.toBase58(), markets: rows } };
  return mkCache.v;
}
const resolutions = () => { const f = path.join(__dirname, "../data/resolutions.jsonl"); return fs.existsSync(f) ? fs.readFileSync(f, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)).reverse() : []; };

const volCache = {};
async function sigmaFor(asset) {
  const c = volCache[asset];
  if (c && Date.now() - c.t < 10 * 60e3) return c.v;
  let v = 0.6;
  try { v = realizedVol(await hourlyCloses(asset), 3600); } catch {}
  volCache[asset] = { v, t: Date.now() };
  return v;
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, "http://x");
  const send = (code, obj, type = "application/json") => { res.writeHead(code, { "content-type": type }); res.end(type === "application/json" ? JSON.stringify(obj) : obj); };
  try {
    if (u.pathname === "/") return send(200, fs.readFileSync(path.join(__dirname, "../public/index.html"), "utf8"), "text/html");
    if (u.pathname === "/api/fair") {
      const asset = (u.searchParams.get("asset") || "SOL").toUpperCase();
      const hours = Number(u.searchParams.get("hours") || 24);
      const spot = await pythLatest(asset);
      const sigma = await sigmaFor(asset);
      const strike = Number(u.searchParams.get("strike") || spot.price);
      const secs = hours * 3600;
      return send(200, {
        asset, hours, strike, spot: spot.price, conf: spot.conf, source: spot.source, sigma,
        fairYes: digitalAboveProb({ spot: spot.price, strike, sigmaAnnual: sigma, secsToExpiry: secs }),
        ladder: [0.1, 0.25, 0.5, 0.75, 0.9].map((p) => ({ prob: p, strike: strikeForProb({ spot: spot.price, sigmaAnnual: sigma, secsToExpiry: secs, prob: p }) })),
      });
    }
    if (u.pathname === "/api/markets") return send(200, await strikeMarkets());
    if (u.pathname === "/api/resolutions") return send(200, resolutions());
    if (u.pathname === "/api/resolve") return send(200, await decide(u.searchParams.get("name") || ""));
    send(404, { error: "not found" });
  } catch (e) { send(500, { error: e.message }); }
});
const port = Number(process.env.PORT || 8787);
server.listen(port, () => console.log(`StrikeBook dev server on http://localhost:${port}`));
