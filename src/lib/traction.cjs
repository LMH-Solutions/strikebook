// Honest traction (pure): classify every devnet transaction that touched a StrikeBook market and split the activity
// into OUR wallets (keeper/LP, edge-trader bot, team E2E test burners) vs OUTSIDE wallets. The submission must never
// present our own bot volume as organic, so "outside" is anything not on the published team-wallet list.
const MUSDC = "3WQ8hCqTNwjrh8WzE2XyoZoUrd1miPcwWfMkmFPUMEWZ";
const GROUPS = ["keeper", "traderBot", "teamTest", "outside"];
const r6 = (x) => Math.round(x * 1e6) / 1e6;

// Instruction names come from the Anchor "Program log: Instruction: X" lines of the pm-AMM program.
function kindOf(logs = []) {
  const ix = logs.filter((l) => /Program log: Instruction: /.test(l)).map((l) => l.split("Instruction: ")[1].trim());
  if (ix.includes("InitializeMarket")) return "create";
  if (ix.includes("Swap")) return "swap";
  if (ix.includes("ResolveMarket")) return "resolve";
  if (ix.some((n) => /^Claim/.test(n))) return "claim";
  if (ix.some((n) => /Liquidity/.test(n))) return "liquidity";
  return ix.length ? "other" : "unknown";
}
// Signed mUSDC change (in mUSDC, 6 dp) of `owner` in one parsed tx.
function usdcDelta(meta, owner) {
  const sum = (arr) => (arr || []).filter((b) => b.mint === MUSDC && b.owner === owner).reduce((a, b) => a + Number(b.uiTokenAmount.amount), 0);
  return r6((sum(meta?.postTokenBalances) - sum(meta?.preTokenBalances)) / 1e6);
}
// Compact event from a getParsedTransaction result (only what the summary needs; this is what gets cached).
function eventFromTx(market, sig, tx) {
  const keys = tx.transaction.message.accountKeys;
  const wallet = (keys[0].pubkey?.toBase58?.() || String(keys[0].pubkey || keys[0]));
  const kind = kindOf(tx.meta?.logMessages);
  const d = usdcDelta(tx.meta, wallet);
  return { sig, market, at: tx.blockTime, wallet, kind, usdc: d, err: tx.meta?.err ? 1 : 0 };
}
function groupOf(wallet, team) {
  if ((team.keeper || []).includes(wallet)) return "keeper";
  if ((team.traderBot || []).includes(wallet)) return "traderBot";
  if ((team.teamTest || []).includes(wallet)) return "teamTest";
  return "outside";
}
const blank = () => ({ trades: 0, buys: 0, sells: 0, volumeUsdc: 0, claims: 0, wallets: 0, markets: 0 });

// events: eventFromTx outputs; markets: data/markets.jsonl rows (live); resolutions: data/resolutions.jsonl rows.
function summarize(events, { team = {}, markets = [], resolutions = [], now = Math.floor(Date.now() / 1000), scannedAt = null, sinceTs = null } = {}) {
  const live = markets.filter((m) => m.market && !m.dry);
  const resolved = new Set(resolutions.filter((r) => r.market && (r.signature || r.resolveTx || r.tx)).map((r) => r.market));
  const g = Object.fromEntries(GROUPS.map((k) => [k, blank()]));
  const sets = Object.fromEntries(GROUPS.map((k) => [k, { w: new Set(), m: new Set() }]));
  const outside = new Map();
  for (const e of events) {
    if (e.err || (sinceTs && e.at < sinceTs)) continue;
    const k = groupOf(e.wallet, team), G = g[k];
    if (e.kind === "swap") {
      G.trades++; if (e.usdc < 0) G.buys++; else if (e.usdc > 0) G.sells++;
      G.volumeUsdc += Math.abs(e.usdc); sets[k].w.add(e.wallet); sets[k].m.add(e.market);
    } else if (e.kind === "claim") { G.claims++; sets[k].w.add(e.wallet); }
    else continue;
    if (k === "outside") {
      const o = outside.get(e.wallet) || { wallet: e.wallet, trades: 0, volumeUsdc: 0, claims: 0, firstAt: e.at, lastAt: e.at };
      if (e.kind === "swap") { o.trades++; o.volumeUsdc += Math.abs(e.usdc); } else o.claims++;
      o.firstAt = Math.min(o.firstAt, e.at); o.lastAt = Math.max(o.lastAt, e.at); outside.set(e.wallet, o);
    }
  }
  for (const k of GROUPS) { g[k].wallets = sets[k].w.size; g[k].markets = sets[k].m.size; g[k].volumeUsdc = r6(g[k].volumeUsdc); }
  const ours = blank();
  for (const k of GROUPS.slice(0, 3)) for (const f of Object.keys(ours)) ours[f] += g[k][f];
  ours.volumeUsdc = r6(ours.volumeUsdc);
  const all = blank();
  for (const f of Object.keys(all)) all[f] = r6(ours[f] + g.outside[f]);
  const total = all.volumeUsdc || 0;
  return {
    schema: "strikebook.traction.v1", generatedAt: now, scannedAt, sinceTs, cluster: "devnet",
    markets: { created: live.length, resolved: live.filter((m) => resolved.has(m.market)).length, open: live.filter((m) => !resolved.has(m.market) && m.endTs > now).length },
    all, ours, outside: g.outside, byGroup: g,
    outsideShareOfVolume: total ? r6(g.outside.volumeUsdc / total) : 0,
    outsideWallets: [...outside.values()].map((o) => ({ ...o, volumeUsdc: r6(o.volumeUsdc) })).sort((a, b) => b.volumeUsdc - a.volumeUsdc),
    teamWallets: team,
    note: "Counts every finalized devnet tx that touched a StrikeBook market account. keeper = market creator/LP/resolver wallet; traderBot = our edge-trader; teamTest = burners we used for E2E tests. Only 'outside' is third-party activity.",
  };
}
module.exports = { MUSDC, GROUPS, kindOf, usdcDelta, eventFromTx, groupOf, summarize };
