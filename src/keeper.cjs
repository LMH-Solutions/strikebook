#!/usr/bin/env node
// StrikeBook keeper (DEVNET). Creates fair-seeded strike ladders on the pm-AMM and resolves them
// from the Pyth oracle at expiry, appending every resolution (with its oracle proof) to
// data/resolutions.jsonl.
//
//   node src/keeper.cjs status
//   node src/keeper.cjs ladder  --asset SOL --mins 10 --deposit 20 [--probs 0.25,0.5,0.75] [--dry]
//   node src/keeper.cjs resolve [--dry]
//   node src/keeper.cjs claim            (claimWinnings + claimLpResiduals on our resolved markets)
//   node src/keeper.cjs tick    [--assets SOL,BTC] [--grid-hours 6] [--lead-mins 60] [--max-rungs 3] [--deposit 25] [--dry]
//                                one idempotent pass: resolve due -> claim -> faucet if short -> roll ladders -> rebuild log.
//                                Safe to call from cron / a scheduled routine (no always-on host needed).
//   node src/keeper.cjs run     (same flags as tick) [--poll 60]   loop of ticks
//   node src/keeper.cjs log      rebuild data/resolution-log.json from the jsonl logs
const fs = require("fs");
const path = require("path");
const { PublicKey } = require("@solana/web3.js");
const pm = require("./lib/pmamm.cjs");
const { pythLatest, hourlyCloses } = require("./lib/feeds.cjs");
const { realizedVol } = require("./lib/pricing.cjs");
const { planLadder, nextExpiry, DEFAULT_PROBS } = require("./lib/ladder.cjs");
const { parseStrikeName, decide } = require("./lib/resolver.cjs");
const { planTick } = require("./lib/roller.cjs");
const { buildResolutionLog } = require("./lib/reslog.cjs");

const DATA = path.join(__dirname, "../data");
const LOG = path.join(DATA, "resolutions.jsonl");
const CREATED = path.join(DATA, "markets.jsonl");
const CLAIMS = path.join(DATA, "claims.jsonl");
const TRADES = path.join(DATA, "trades.jsonl"); // written by src/trader.cjs (edge re-centering trader)
const RESLOG = path.join(DATA, "resolution-log.json");
const STATE = path.join(DATA, "keeper-state.json"); // local only (gitignored): last faucet attempt
const FAUCET_EVERY = 3600; // pm-AMM faucet: 1 claim / hour / wallet
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

// After resolution: pull LP residuals FIRST (they pay out outcome tokens), then claim winnings, back to the builder
// wallet (recycles mUSDC and closes token accounts, which also refunds some SOL rent). A claim that keeps failing
// simulation (nothing to claim) is given up after MAX_CLAIM_TRIES ticks so the keeper doesn't re-spend RPC on it.
const MAX_CLAIM_TRIES = 3;
function claimsDone(records) {
  const tries = {}, done = new Set();
  for (const c of records) {
    const key = `${c.market}:${c.kind}`;
    if (c.signature) done.add(key);
    else if (c.skipped && (tries[key] = (tries[key] || 0) + 1) >= MAX_CLAIM_TRIES) done.add(key);
  }
  return done;
}
async function claimResolved(client, me) {
  const out = [];
  const done = claimsDone(readJsonl(CLAIMS));
  for (const m of await ourMarkets(client, me)) {
    if (!m.account.resolved || !parseStrikeName(m.name)) continue;
    for (const kind of ["claimLpResiduals", "claimWinnings"]) {
      const key = `${m.market.toBase58()}:${kind}`;
      if (done.has(key)) continue;
      try {
        const rec = { market: m.market.toBase58(), name: m.name, kind, signature: await client.send[kind](m.market), at: Math.floor(Date.now() / 1000) };
        append(CLAIMS, rec); out.push(rec);
      }
      catch (e) {
        const rec = { market: m.market.toBase58(), name: m.name, kind, skipped: String(e.message || e).split("\n")[0].slice(0, 120), at: Math.floor(Date.now() / 1000) };
        if (/simulation failed|custom program error|AnchorError/i.test(rec.skipped)) append(CLAIMS, rec); // permanent-looking; network errors just retry
        out.push(rec);
      }
    }
  }
  return out;
}

function writeResolutionLog() {
  const log = buildResolutionLog({ created: readJsonl(CREATED), resolved: readJsonl(LOG), claims: readJsonl(CLAIMS), trades: readJsonl(TRADES),
    program: pm.PROGRAM_ID.toBase58(), app: pm.APP });
  fs.mkdirSync(DATA, { recursive: true });
  fs.writeFileSync(RESLOG, JSON.stringify(log, null, 2) + "\n");
  return log;
}
const readState = () => { try { return JSON.parse(fs.readFileSync(STATE, "utf8")); } catch { return {}; } };

function tickConfig(a, probs) {
  return { assets: String(a.assets || "SOL,BTC").toUpperCase().split(","), gridSecs: Math.round(Number(a["grid-hours"] || 6) * 3600),
    minLeadSecs: Math.round(Number(a["lead-mins"] || 60) * 60), maxRungs: Number(a["max-rungs"] || 3), deposit: Number(a.deposit || 25),
    probs: a.probs ? probs : undefined, dry: !!a.dry };
}

// One idempotent keeper pass. With cfg.dry nothing is signed and no logs are written; it returns the plan.
async function tick(client, conn, me, cfg) {
  const dry = !!cfg.dry;
  const now = () => Math.floor(Date.now() / 1000);
  const report = { at: now(), dry, resolved: [], claims: [], faucet: null, created: [], plan: null };
  if (dry) report.resolved = await resolveDue(client, me, { dry: true });
  else {
    report.resolved = await resolveDue(client, me);
    report.claims = await claimResolved(client, me); // recycles mUSDC from finished ladders
  }
  const view = async () => (await ourMarkets(client, me)).map((m) => ({ name: m.name, endTs: m.endTs, resolved: m.state.resolved }));
  let markets = await view();
  let balances = await pm.balances(conn, me);
  let plan = planTick({ now: now(), markets, balances, cfg });
  const st = readState();
  if (plan.wantsFaucet) {
    if (dry) report.faucet = { wouldTry: now() - (st.lastFaucet || 0) >= FAUCET_EVERY };
    else if (now() - (st.lastFaucet || 0) >= FAUCET_EVERY) {
      report.faucet = await pm.faucet(me).catch((e) => ({ error: String(e.message || e) }));
      fs.mkdirSync(DATA, { recursive: true });
      fs.writeFileSync(STATE, JSON.stringify({ ...st, lastFaucet: now(), lastFaucetResult: report.faucet }));
      await sleep(4000);
      balances = await pm.balances(conn, me);
      plan = planTick({ now: now(), markets, balances, cfg });
    } else report.faucet = { skipped: `next faucet in ${FAUCET_EVERY - (now() - st.lastFaucet)}s` };
  }
  report.plan = plan;
  report.balances = balances;
  for (const c of plan.create) {
    try { report.created.push(await createLadder(client, { asset: c.asset, endTs: c.endTs, deposit: c.deposit, probs: c.probs, dry })); }
    catch (e) { report.created.push({ asset: c.asset, error: String(e.message || e).split("\n")[0] }); }
  }
  if (!dry) report.log = writeResolutionLog().stats;
  report.summary = { resolved: report.resolved.length, claims: report.claims.filter((c) => c.signature).length,
    created: report.created.reduce((s, c) => s + (c.rungs ? c.rungs.length : 0), 0), skipped: plan.skipped.map((s) => `${s.asset}:${s.reason}`),
    sol: +balances.sol.toFixed(4), usdc: balances.usdc };
  return report;
}

async function main() {
  const a = args();
  const cmd = a._[0] || "status";
  const kp = pm.loadKeypair();
  const rpc = await pm.pickRpc();
  const conn = pm.connection(rpc);
  const client = cmd === "status" || cmd === "log" || a.dry ? pm.readOnlyClient(conn) : pm.signingClient(kp, conn);
  const me = kp.publicKey;
  const probs = a.probs ? String(a.probs).split(",").map(Number) : DEFAULT_PROBS;

  if (cmd === "status") {
    const mk = await ourMarkets(client, me);
    console.log(JSON.stringify({ wallet: me.toBase58(), rpc, balances: await pm.balances(conn, me),
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
  } else if (cmd === "tick" || cmd === "run") {
    const cfg = tickConfig(a, probs);
    if (cmd === "tick") { console.log(JSON.stringify(await tick(client, conn, me, cfg), null, 2)); return; }
    const poll = Number(a.poll || 60) * 1000;
    console.log(`keeper running: ${JSON.stringify({ ...cfg, wallet: me.toBase58() })}`);
    for (;;) {
      try { const r = await tick(client, conn, me, cfg); console.log(new Date().toISOString(), JSON.stringify(r.summary)); }
      catch (e) { console.error("keeper tick error:", e.message || e); }
      await sleep(poll);
    }
  } else if (cmd === "log") {
    console.log(JSON.stringify(writeResolutionLog().stats, null, 2));
  } else throw new Error(`unknown command ${cmd}`);
}
module.exports = { claimsDone, ourMarkets, createLadder, resolveDue, claimResolved, tick, writeResolutionLog, readJsonl, LOG, CREATED, RESLOG };
if (require.main === module) main().catch((e) => { console.error(e.message || e); if (e.logs) console.error(e.logs.join("\n")); process.exit(1); });
