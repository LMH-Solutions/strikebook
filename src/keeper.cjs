#!/usr/bin/env node
// StrikeBook keeper (DEVNET). Creates fair-seeded strike ladders on the pm-AMM and resolves them
// from the Pyth oracle at expiry, appending every resolution (with its oracle proof) to
// data/resolutions.jsonl.
//
//   node src/keeper.cjs status
//   node src/keeper.cjs ladder  --asset SOL --mins 10 --deposit 20 [--probs 0.25,0.5,0.75] [--dry]
//   node src/keeper.cjs resolve [--dry]
//   node src/keeper.cjs claim            (claimWinnings + claimLpResiduals on our resolved markets)
//   node src/keeper.cjs run     [--assets SOL,BTC] [--grid-hours 6] [--deposit 25] [--poll 20]
const fs = require("fs");
const path = require("path");
const { PublicKey } = require("@solana/web3.js");
const pm = require("./lib/pmamm.cjs");
const { pythLatest, hourlyCloses } = require("./lib/feeds.cjs");
const { realizedVol } = require("./lib/pricing.cjs");
const { planLadder, nextExpiry, DEFAULT_PROBS } = require("./lib/ladder.cjs");
const { parseStrikeName, decide } = require("./lib/resolver.cjs");

const DATA = path.join(__dirname, "../data");
const LOG = path.join(DATA, "resolutions.jsonl");
const CREATED = path.join(DATA, "markets.jsonl");
const CLAIMS = path.join(DATA, "claims.jsonl");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function args() {
  const a = { _: [] };
  const v = process.argv.slice(2);
  for (let i = 0; i < v.length; i++) {
    if (v[i].startsWith("--")) { const k = v[i].slice(2); a[k] = v[i + 1] && !v[i + 1].startsWith("--") ? v[++i] : true; } else a._.push(v[i]);
  }
  return a;
}
const append = (f, obj) => { fs.mkdirSync(DATA, { recursive: true }); fs.appendFileSync(f, JSON.stringify(obj) + "\n"); };
const readJsonl = (f) => (fs.existsSync(f) ? fs.readFileSync(f, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);

async function sigmaFor(asset) { try { return realizedVol(await hourlyCloses(asset), 3600); } catch { return 0.6; } }

async function ourMarkets(client, me) {
  const all = await client.fetchAllMarkets(443);
  return all.filter(({ account: a }) => a.authority.equals(me)).map(({ publicKey, account: a }) => ({
    market: publicKey, account: a, name: pm.decodeName(a.name), endTs: pm.toNum(a.endTs), marketId: pm.toNum(a.marketId), state: pm.marketState(a),
  }));
}

async function createLadder(client, { asset, endTs, deposit, probs, dry }) {
  const spot = await pythLatest(asset);
  const sigma = await sigmaFor(asset);
  const rungs = planLadder({ asset, spot: spot.price, sigmaAnnual: sigma, endTs, probs });
  const out = [];
  for (const r of rungs) {
    const durationSecs = r.endTs - Math.floor(Date.now() / 1000);
    if (dry) { out.push({ ...r, dry: true }); continue; }
    const res = await client.send.createMarket({ name: r.name, durationSecs, initialPriceBps: r.initialPriceBps, depositUsdc: deposit });
    const rec = { ...r, spot: spot.price, spotPublishTime: spot.publishTime, spotSource: spot.source, sigmaAnnual: sigma, depositUsdc: deposit,
      marketId: res.marketId, market: res.marketPda, signature: res.signature, createdAt: Math.floor(Date.now() / 1000),
      url: `${pm.APP}/market/${res.marketId}` };
    append(CREATED, rec);
    out.push(rec);
    console.log(`created ${r.name} @ ${(r.fairYes * 100).toFixed(1)}%  ${rec.market}`);
  }
  return { spot: spot.price, sigma, rungs: out };
}

async function resolveDue(client, me, { dry } = {}) {
  const done = [];
  const now = Math.floor(Date.now() / 1000);
  for (const m of await ourMarkets(client, me)) {
    if (m.account.resolved || !parseStrikeName(m.name)) continue;
    let d;
    try { d = await decide(m.name, now, { onchainEndTs: m.endTs }); }
    catch (e) { console.log(`wait ${m.name}: ${e.message}`); continue; } // not-final oracle: retry next tick
    if (d.status !== "decided") continue;
    let signature = null;
    if (!dry) signature = await client.send.resolveMarket(m.market, d.side);
    const rec = { market: m.market.toBase58(), marketId: m.marketId, name: m.name, asset: d.asset, strike: d.strike, endTs: d.endTs,
      onchainEndTs: m.endTs, side: d.side, oraclePrice: d.oraclePrice, oracleConf: d.oracleConf, oracleTs: d.oracleTs,
      oracleSource: d.oracleSource, resolvedAt: Math.floor(Date.now() / 1000), signature, dry: !!dry };
    if (!dry) append(LOG, rec);
    console.log(`${dry ? "[dry] " : ""}resolved ${m.name} -> ${d.side.toUpperCase()} (oracle ${d.oraclePrice} @ ${d.oracleTs}, ${d.oracleSource})`);
    done.push(rec);
  }
  return done;
}

// After resolution: pull our winning tokens + LP residuals back to the builder wallet (recycles mUSDC).
async function claimResolved(client, me) {
  const out = [];
  const done = new Set(readJsonl(CLAIMS).map((c) => `${c.market}:${c.kind}`));
  for (const m of await ourMarkets(client, me)) {
    if (!m.account.resolved || !parseStrikeName(m.name)) continue;
    for (const kind of ["claimWinnings", "claimLpResiduals"]) {
      const key = `${m.market.toBase58()}:${kind}`;
      if (done.has(key)) continue;
      try {
        const rec = { market: m.market.toBase58(), name: m.name, kind, signature: await client.send[kind](m.market), at: Math.floor(Date.now() / 1000) };
        append(CLAIMS, rec); out.push(rec);
      }
      catch (e) { out.push({ name: m.name, kind, skipped: String(e.message || e).split("\n")[0].slice(0, 120) }); }
    }
  }
  return out;
}

async function main() {
  const a = args();
  const cmd = a._[0] || "status";
  const kp = pm.loadKeypair();
  const conn = pm.connection();
  const client = cmd === "status" || a.dry ? pm.readOnlyClient(conn) : pm.signingClient(kp, conn);
  const me = kp.publicKey;
  const probs = a.probs ? String(a.probs).split(",").map(Number) : DEFAULT_PROBS;

  if (cmd === "status") {
    const mk = await ourMarkets(client, me);
    console.log(JSON.stringify({ wallet: me.toBase58(), rpc: pm.RPC, balances: await pm.balances(conn, me),
      markets: mk.map((m) => ({ market: m.market.toBase58(), id: m.marketId, name: m.name, endTs: m.endTs, yes: +m.state.price.toFixed(4), resolved: m.state.resolved, winner: m.state.winner })),
      resolutions: readJsonl(LOG).length }, null, 2));
  } else if (cmd === "ladder") {
    const asset = String(a.asset || "SOL").toUpperCase();
    const endTs = a.end ? Number(a.end) : Math.floor(Date.now() / 1000) + Math.round(Number(a.mins || 60) * 60) + 15;
    console.log(JSON.stringify(await createLadder(client, { asset, endTs, deposit: Number(a.deposit || 20), probs, dry: !!a.dry }), null, 2));
  } else if (cmd === "resolve") {
    console.log(JSON.stringify(await resolveDue(client, me, { dry: !!a.dry }), null, 2));
  } else if (cmd === "claim") {
    console.log(JSON.stringify(await claimResolved(client, me), null, 2));
  } else if (cmd === "run") {
    const assets = String(a.assets || "SOL").toUpperCase().split(",");
    const grid = Number(a["grid-hours"] || 6) * 3600, poll = Number(a.poll || 20) * 1000, deposit = Number(a.deposit || 25);
    console.log(`keeper running: assets=${assets} grid=${grid / 3600}h deposit=${deposit} wallet=${me.toBase58()}`);
    for (;;) {
      try {
        await resolveDue(client, me);
        const now = Math.floor(Date.now() / 1000);
        const endTs = nextExpiry(now, grid);
        const live = (await ourMarkets(client, me)).filter((m) => !m.state.resolved && m.endTs > now);
        for (const asset of assets) {
          if (live.some((m) => parseStrikeName(m.name)?.asset === asset && parseStrikeName(m.name)?.endTs === endTs)) continue;
          const bal = await pm.balances(conn, me);
          if (bal.usdc < deposit * probs.length || bal.sol < 0.03) { console.log(`skip ${asset} ladder: low balance`, bal); continue; }
          await createLadder(client, { asset, endTs, deposit, probs });
        }
      } catch (e) { console.error("keeper tick error:", e.message || e); }
      await sleep(poll);
    }
  } else throw new Error(`unknown command ${cmd}`);
}
module.exports = { ourMarkets, createLadder, resolveDue, claimResolved, readJsonl, LOG, CREATED };
if (require.main === module) main().catch((e) => { console.error(e.message || e); if (e.logs) console.error(e.logs.join("\n")); process.exit(1); });
