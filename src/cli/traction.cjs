#!/usr/bin/env node
// Honest traction metrics: scans every devnet tx on every StrikeBook market (read-only RPC, no keys), splits it into
// keeper / trader-bot / team-test vs OUTSIDE wallets, writes docs/traction.json and prints a table.
//   npm run traction                 # incremental scan (cache: data/traction-cache.json, gitignored) + print
//   npm run traction -- --offline    # no RPC: summarise the cache only
//   npm run traction -- --json       # print the JSON instead of the table
//   npm run traction -- --quiet      # (keeper loop) one summary line
const fs = require("fs");
const path = require("path");
const { PublicKey } = require("@solana/web3.js");
const { connection, pickRpc } = require("../lib/pmamm.cjs");
const { eventFromTx, summarize } = require("../lib/traction.cjs");

const root = path.join(__dirname, "../..");
const P = (f) => path.join(root, f);
const jsonl = (f) => (fs.existsSync(P(f)) ? fs.readFileSync(P(f), "utf8").split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean) : []);
const args = process.argv.slice(2), has = (f) => args.includes(f);
const CACHE = P("data/traction-cache.json"), OUT = P(process.env.SITE_OUT || "docs");
const TESTER_LAUNCH = 1794578400; // 2026-11-13T14:00:00Z: "Try StrikeBook on devnet" tester page went live (for the since-launch split)
const SCAN_RPCS = process.env.RPC_URL ? [process.env.RPC_URL] : ["https://devnet.rpcpool.com", "https://explorer-api.devnet.solana.com", "https://api.devnet.solana.com"];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function scan(markets, cache, { budgetMs = Number(process.env.TRACTION_BUDGET_MS || 180_000) } = {}) {
  // Prefer the RPCs the keeper does NOT use first (it takes api.devnet), and round-robin tx fetches across all healthy ones,
  // so the scan never starves the keeper's 15-min tick of rate limit.
  const healthy = [];
  for (const u of SCAN_RPCS) { try { healthy.push(await pickRpc([u], { timeoutMs: 5000 })); } catch {} }
  if (!healthy.length) throw new Error("no healthy devnet RPC");
  const pool = healthy.map((u) => connection(u));
  let rr = 0;
  const conn = pool[0], next = () => pool[rr++ % pool.length];
  const t0 = Date.now(), now = Math.floor(Date.now() / 1000);
  let fetched = 0, skipped = 0;
  for (const m of markets) {
    if (Date.now() - t0 > budgetMs) { skipped++; continue; }
    const st = cache.markets[m.market] || {};
    // settled long ago and already scanned after settlement + 1 day: nothing new is expected
    if (st.scannedAt && m.endTs < now - 3 * 86400 && st.scannedAt > m.endTs + 86400) continue;
    const sigs = [];
    let before;
    for (;;) {
      const page = await conn.getSignaturesForAddress(new PublicKey(m.market), { until: st.newest, before, limit: 1000 });
      sigs.push(...page);
      if (page.length < 1000) break;
      before = page[page.length - 1].signature;
    }
    let partial = false;
    for (const s of sigs.reverse()) {
      if (cache.events[s.signature]) continue;
      if (Date.now() - t0 > budgetMs) { partial = true; break; } // resume next run (events are cached per signature)
      if (s.err) { cache.events[s.signature] = { sig: s.signature, market: m.market, at: s.blockTime, err: 1 }; continue; }
      let tx = null;
      for (let i = 0; i < 4 && !tx; i++) { try { tx = await next().getParsedTransaction(s.signature, { maxSupportedTransactionVersion: 0, commitment: "confirmed" }); } catch { await sleep(1500 * (i + 1)); } }
      if (!tx) throw new Error(`could not fetch ${s.signature}`);
      cache.events[s.signature] = eventFromTx(m.market, s.signature, tx);
      fetched++;
      await sleep(120);
    }
    if (partial) { skipped++; continue; }
    if (sigs.length) st.newest = sigs[sigs.length - 1].signature;
    st.scannedAt = now; cache.markets[m.market] = st;
    if (process.env.TRACTION_VERBOSE) console.error(`scanned ${m.name}: ${sigs.length} new sigs, ${fetched} fetched so far`);
    fs.writeFileSync(CACHE, JSON.stringify(cache));
    await sleep(150);
  }
  return { fetched, skipped };
}

(async () => {
  const markets = jsonl("data/markets.jsonl").filter((m) => m.market && !m.dry);
  const resolutions = jsonl("data/resolutions.jsonl");
  const team = JSON.parse(fs.readFileSync(P("data/team-wallets.json"), "utf8"));
  delete team._note;
  const cache = fs.existsSync(CACHE) ? JSON.parse(fs.readFileSync(CACHE, "utf8")) : { markets: {}, events: {} };
  let info = { fetched: 0, skipped: 0 };
  if (!has("--offline")) {
    try { info = await scan(markets, cache); } catch (e) { info.error = String(e.message || e).slice(0, 200); }
    cache.scannedAt = Math.floor(Date.now() / 1000);
    fs.writeFileSync(CACHE, JSON.stringify(cache));
  }
  const events = Object.values(cache.events);
  const s = summarize(events, { team, markets, resolutions, scannedAt: cache.scannedAt || null });
  s.sinceTesterLaunch = summarize(events, { team, markets, resolutions, sinceTs: TESTER_LAUNCH }).outside;
  s.sinceTesterLaunch.since = TESTER_LAUNCH;
  s.scan = { ...info, txsCached: events.length, marketsScanned: Object.keys(cache.markets).length };
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, "traction.json"), JSON.stringify(s, null, 1) + "\n");
  if (has("--json")) return console.log(JSON.stringify(s, null, 2));
  const o = s.outside, u = s.ours;
  if (has("--quiet")) return console.log(`traction: outside ${o.trades} trades/${o.volumeUsdc.toFixed(2)} mUSDC/${o.wallets} wallets; ours ${u.trades}/${u.volumeUsdc.toFixed(2)}/${u.wallets}; +${info.fetched} txs${info.error ? " ERROR " + info.error : ""}`);
  const row = (k, G) => `${k.padEnd(22)}${String(G.trades).padStart(7)}${String(G.buys).padStart(6)}${String(G.sells).padStart(6)}${G.volumeUsdc.toFixed(2).padStart(12)}${String(G.claims).padStart(7)}${String(G.wallets).padStart(8)}`;
  console.log(`StrikeBook devnet traction  (scanned ${new Date((s.scannedAt || 0) * 1000).toISOString()}, ${events.length} txs cached, +${info.fetched} new${info.error ? ", SCAN ERROR: " + info.error : ""})`);
  console.log(`markets: ${s.markets.created} created, ${s.markets.resolved} resolved, ${s.markets.open} open`);
  console.log(`${"wallet group".padEnd(22)}${"trades".padStart(7)}${"buys".padStart(6)}${"sells".padStart(6)}${"vol mUSDC".padStart(12)}${"claims".padStart(7)}${"wallets".padStart(8)}`);
  console.log(row("keeper (creator/LP)", s.byGroup.keeper));
  console.log(row("trader bot (ours)", s.byGroup.traderBot));
  console.log(row("team E2E burners", s.byGroup.teamTest));
  console.log(row("= ours total", u));
  console.log(row("OUTSIDE wallets", o));
  console.log(`outside share of volume: ${(s.outsideShareOfVolume * 100).toFixed(2)}%  ·  outside since tester launch: ${s.sinceTesterLaunch.trades} trades, ${s.sinceTesterLaunch.wallets} wallets`);
  for (const w of s.outsideWallets.slice(0, 20)) console.log(`  outside ${w.wallet}  ${w.trades} trades  ${w.volumeUsdc.toFixed(2)} mUSDC  first ${new Date(w.firstAt * 1000).toISOString()}`);
})().catch((e) => { console.error("Error:", e.message || e); process.exit(1); });
