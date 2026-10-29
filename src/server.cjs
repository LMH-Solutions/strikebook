#!/usr/bin/env node
// Minimal local dashboard: GET / (HTML), GET /api/fair?asset=SOL&strike=105&hours=24, GET /api/resolve?name=SOL>100@1793270000
const http = require("http");
const fs = require("fs");
const path = require("path");
const { pythLatest, hourlyCloses } = require("./lib/feeds.cjs");
const { digitalAboveProb, realizedVol, strikeForProb } = require("./lib/pricing.cjs");
const { decide } = require("./lib/resolver.cjs");

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
    if (u.pathname === "/api/resolve") return send(200, await decide(u.searchParams.get("name") || ""));
    send(404, { error: "not found" });
  } catch (e) { send(500, { error: e.message }); }
});
const port = Number(process.env.PORT || 8787);
server.listen(port, () => console.log(`StrikeBook dev server on http://localhost:${port}`));
