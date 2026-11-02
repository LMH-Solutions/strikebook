#!/usr/bin/env node
// StrikeBook edge re-centering trader (DEVNET). One idempotent pass, run by scripts/tick-loop.sh after the keeper tick:
//   1. claim winnings on resolved markets we traded (recycles mUSDC, closes token accounts -> refunds rent SOL)
//   2. faucet the trader wallet if it is short (pm-AMM faucet: 1 claim / hour / wallet)
//   3. for every open ladder rung created by the keeper wallet: model P(YES) = Phi(d2) from the live Pyth spot and
//      realised vol, compare to the pm-AMM price, and buy the cheap side toward the model when |gap| > fee + minEdge
//   4. append each trade (market, side, size, model prob, AMM price before/after, fee, tx) to data/trades.jsonl
//
// The trader uses its OWN throwaway devnet wallet (../.devnet-keys/trader.json), distinct from the LP/keeper wallet,
// so it pays the real swap fee (50% to the market creator = our LP, 50% to the protocol DAO).
//   node src/trader.cjs run   [--dry] [--max-trade 20] [--max-market 60] [--min-edge 0.03] [--budget 200]
//   node src/trader.cjs status
const fs = require("fs");
const path = require("path");
const { PublicKey } = require("@solana/web3.js");
const pm = require("./lib/pmamm.cjs");
const { pythLatest, hourlyCloses } = require("./lib/feeds.cjs");
const { realizedVol } = require("./lib/pricing.cjs");
const { parseStrikeName } = require("./lib/resolver.cjs");
const { decideTrade, modelProb, tradeStats } = require("./lib/trader.cjs");

const DATA = path.join(__dirname, "../data");
const TRADES = path.join(DATA, "trades.jsonl");
const TCLAIMS = path.join(DATA, "trader-claims.jsonl");
const STATE = path.join(DATA, "trader-state.json"); // local only (gitignored)
const TRADER_KEY = process.env.TRADER_KEYPAIR || path.join(path.dirname(pm.KEY_FILE), "trader.json");
const MIN_SOL = 0.02; // below this: faucet first, and never start a swap (each new market costs ~0.004 SOL of ATA rent)
const SWAP_SOL = 0.0045;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const append = (f, o) => { fs.mkdirSync(DATA, { recursive: true }); fs.appendFileSync(f, JSON.stringify(o) + "\n"); };
const readJsonl = (f) => (fs.existsSync(f) ? fs.readFileSync(f, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
const readState = () => { try { return JSON.parse(fs.readFileSync(STATE, "utf8")); } catch { return {}; } };
function args() {
  const a = { _: [] }; const v = process.argv.slice(2);
  for (let i = 0; i < v.length; i++) { if (v[i].startsWith("--")) { const k = v[i].slice(2); a[k] = v[i + 1] && !v[i + 1].startsWith("--") ? v[++i] : true; } else a._.push(v[i]); }
  return a;
}

async function run(a) {
  const dry = !!a.dry;
  const builder = pm.loadKeypair(); // keeper/LP wallet: only its public key is used here (whose markets to trade)
  const trader = pm.loadKeypair(TRADER_KEY);
  const rpc = await pm.pickRpc();
  const conn = pm.connection(rpc);
  const client = dry ? pm.readOnlyClient(conn) : pm.signingClient(trader, conn);
  const me = trader.publicKey;
  const now = () => Math.floor(Date.now() / 1000);
  const cfg = { maxTradeUsdc: Number(a["max-trade"] || 20), maxMarketUsdc: Number(a["max-market"] || 60), minEdge: Number(a["min-edge"] || 0.03) };
  const report = { at: now(), dry, trader: me.toBase58(), claims: [], faucet: null, trades: [], skipped: [] };
  const trades = readJsonl(TRADES).filter((t) => t.signature);

  const all = (await client.fetchAllMarkets(443)).filter(({ account: m }) => m.authority.equals(builder.publicKey))
    .map(({ publicKey, account }) => ({ market: publicKey, account, name: pm.decodeName(account.name), strike: parseStrikeName(pm.decodeName(account.name)) }))
    .filter((m) => m.strike);

  // 1. claim winnings on resolved markets we traded
  const claimed = new Set(readJsonl(TCLAIMS).filter((c) => c.signature || c.permanent).map((c) => c.market));
  const traded = new Set(trades.map((t) => t.market));
  for (const m of all) {
    const k = m.market.toBase58();
    if (!m.account.resolved || !traded.has(k) || claimed.has(k)) continue;
    if (dry) { report.claims.push({ market: k, name: m.name, wouldClaim: true }); continue; }
    try { const rec = { market: k, name: m.name, signature: await client.send.claimWinnings(m.market), at: now() }; append(TCLAIMS, rec); report.claims.push(rec); }
    catch (e) {
      const msg = String(e.message || e).split("\n")[0].slice(0, 120);
      const rec = { market: k, name: m.name, skipped: msg, at: now(), permanent: /simulation failed|custom program error|AnchorError/i.test(msg) };
      if (rec.permanent) append(TCLAIMS, rec); // e.g. we only held the losing side: nothing to claim
      report.claims.push(rec);
    }
  }

  // 2. faucet if short
  let bal = await pm.balances(conn, me);
  const st = readState();
  if ((bal.sol < MIN_SOL * 3 || bal.usdc < cfg.maxTradeUsdc * 2) && now() - (st.lastFaucet || 0) >= 3600) {
    if (dry) report.faucet = { wouldTry: true };
    else {
      report.faucet = await pm.faucet(me).catch((e) => ({ error: String(e.message || e) }));
      fs.writeFileSync(STATE, JSON.stringify({ ...st, lastFaucet: now(), lastFaucetResult: report.faucet }));
      await sleep(4000); bal = await pm.balances(conn, me);
    }
  }
  report.balancesBefore = bal;

  // 3. trade open rungs toward the model
  const spent = {}; for (const t of trades) spent[t.market] = (spent[t.market] || 0) + t.amountIn;
  let budget = Math.min(Number(a.budget || 200), bal.usdc) * 1e6;
  let sol = bal.sol;
  const model = {};
  const open = all.filter((m) => !m.account.resolved && pm.toNum(m.account.endTs) > now());
  for (const m of open) {
    const k = m.market.toBase58(), { asset, strike, endTs } = m.strike;
    try {
      if (!model[asset]) {
        const spot = await pythLatest(asset);
        let sigma; try { sigma = realizedVol(await hourlyCloses(asset), 3600); } catch { sigma = 0.6; }
        model[asset] = { spot: spot.price, spotPublishTime: spot.publishTime, spotSource: spot.source.split(" ")[0], sigmaAnnual: sigma };
      }
      const M = model[asset];
      const s = pm.marketState(m.account, now());
      const pModel = modelProb({ spot: M.spot, strike, sigmaAnnual: M.sigmaAnnual, endTs, now: now() });
      const d = decideTrade({ s, pModel, held: spent[k] || 0, budget, cfg });
      if (d.action !== "trade") { report.skipped.push({ name: m.name, reason: d.reason, pModel: +pModel.toFixed(4), amm: +s.price.toFixed(4) }); continue; }
      if (sol < MIN_SOL || sol < SWAP_SOL * 2) { report.skipped.push({ name: m.name, reason: "low-sol", sol }); continue; }
      const rec = { market: k, marketId: pm.toNum(m.account.marketId), name: m.name, asset, strike, endTs, side: d.side, dir: d.dir,
        amountIn: d.amountIn, quotedOut: d.quotedOut, fee: d.fee, avgPrice: +d.avgPrice.toFixed(6), pModel: +pModel.toFixed(6),
        ammBefore: +d.ammBefore.toFixed(6), ammAfterEst: +d.ammAfterEst.toFixed(6), evMicro: d.evMicro, spot: M.spot, spotPublishTime: M.spotPublishTime,
        spotSource: M.spotSource, sigmaAnnual: +M.sigmaAnnual.toFixed(6), secsLeft: s.secondsLeft, trader: me.toBase58(), dry };
      if (dry) { report.trades.push(rec); continue; }
      rec.signature = await client.send.swap(m.market, d.dir, d.amountIn, pm.minOutput({ out: d.quotedOut })); // exact quote, 1% slippage bound
      rec.at = now();
      try { rec.ammAfter = +pm.marketState(await client.fetchMarket(m.market), now()).price.toFixed(6); } catch {}
      append(TRADES, rec);
      report.trades.push(rec);
      spent[k] = (spent[k] || 0) + d.amountIn; budget -= d.amountIn; sol -= SWAP_SOL;
      console.error(`traded ${m.name} ${d.side.toUpperCase()} ${(d.amountIn / 1e6).toFixed(2)} mUSDC  model ${(pModel * 100).toFixed(1)}% vs amm ${(s.price * 100).toFixed(1)}% -> ${rec.ammAfter != null ? (rec.ammAfter * 100).toFixed(1) + "%" : "?"}`);
    } catch (e) { report.skipped.push({ name: m.name, reason: "error", error: String(e.message || e).split("\n")[0].slice(0, 160) }); }
  }
  report.model = model;
  report.balancesAfter = dry ? bal : await pm.balances(conn, me);
  report.totals = tradeStats(readJsonl(TRADES));
  return report;
}

async function main() {
  const a = args(); const cmd = a._[0] || "run";
  if (cmd === "run") {
    const r = await run(a);
    console.log(JSON.stringify({ summary: { trades: r.trades.length, claims: r.claims.filter((c) => c.signature).length, skipped: r.skipped.map((s) => `${s.name}:${s.reason}`),
      sol: +r.balancesAfter.sol.toFixed(4), usdc: r.balancesAfter.usdc, faucet: r.faucet && (r.faucet.ok ?? r.faucet.status ?? r.faucet.wouldTry ?? r.faucet.error) }, totals: r.totals, ...(a.verbose || a.dry ? { report: r } : {}) }, null, 2));
  } else if (cmd === "status") {
    const trader = pm.loadKeypair(TRADER_KEY); const conn = pm.connection(await pm.pickRpc());
    console.log(JSON.stringify({ trader: trader.publicKey.toBase58(), balances: await pm.balances(conn, trader.publicKey), totals: tradeStats(readJsonl(TRADES)) }, null, 2));
  } else throw new Error(`unknown command ${cmd}`);
}
module.exports = { run, TRADES, TCLAIMS };
if (require.main === module) main().catch((e) => { console.error(e.message || e); if (e.logs) console.error(e.logs.join("\n")); process.exit(1); });
