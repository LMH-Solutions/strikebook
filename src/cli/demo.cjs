#!/usr/bin/env node
// End-to-end StrikeBook demo on devnet (~6 min): fund -> fair-seeded ladder -> trade -> expire ->
// Pyth-resolve -> claim. Usage: npm run demo [-- --asset SOL --rungs 3 --mins 5 --deposit 20]
const pm = require("../lib/pmamm.cjs");
const k = require("../keeper.cjs");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i > 0 ? process.argv[i + 1] : d; };

(async () => {
  const asset = String(arg("asset", "SOL")).toUpperCase(), rungs = Number(arg("rungs", 3)), mins = Number(arg("mins", 5)), deposit = Number(arg("deposit", 20));
  const probs = rungs === 1 ? [0.5] : rungs === 2 ? [0.3, 0.7] : rungs === 3 ? [0.25, 0.5, 0.75] : [0.1, 0.25, 0.5, 0.75, 0.9];
  const kp = pm.loadKeypair(), conn = pm.connection(), client = pm.signingClient(kp, conn), me = kp.publicKey;
  let bal = await pm.balances(conn, me);
  console.log(`1) builder ${me.toBase58()} ${bal.sol.toFixed(3)} SOL, ${bal.usdc} mUSDC`);
  if (bal.usdc < deposit * probs.length + 5 || bal.sol < 0.04 * probs.length) {
    const f = await pm.faucet(me); console.log("   faucet:", f.status, f.error || `${f.amount} mUSDC, ${f.sol} SOL`);
    await sleep(3000); bal = await pm.balances(conn, me);
    if (bal.sol < 0.036 * probs.length) throw new Error(`need ~${(0.036 * probs.length).toFixed(2)} devnet SOL for rent, have ${bal.sol}`);
  }
  const endTs = Math.floor(Date.now() / 1000) + Math.round(mins * 60) + 15;
  console.log(`2) ladder ${asset}, expiry ${new Date(endTs * 1000).toISOString()}`);
  const L = await k.createLadder(client, { asset, endTs, deposit, probs });
  console.log(`   spot $${L.spot.toFixed(3)} (Pyth on-chain), sigma ${(L.sigma * 100).toFixed(1)}%`);
  const atm = L.rungs[Math.floor(L.rungs.length / 2)];
  const { PublicKey } = require("@solana/web3.js");
  const mkt = new PublicKey(atm.market);
  const m = await client.fetchMarket(mkt);
  const q = pm.quoteSwap(m, "usdcToYes", 5_000_000);
  const sig = await client.send.swap(mkt, "usdcToYes", 5_000_000, pm.minOutput(q));
  console.log(`3) bought ${(q.out / 1e6).toFixed(3)} YES on ${atm.name} for 5 mUSDC  tx ${sig.slice(0, 16)}…`);
  console.log(`   trade it yourself: ${atm.url}`);
  const wait = endTs - Math.floor(Date.now() / 1000) + 3;
  console.log(`4) waiting ${wait}s for expiry…`);
  await sleep(wait * 1000);
  let res = [];
  for (let i = 0; i < 6 && res.length < L.rungs.length; i++) { res = res.concat(await k.resolveDue(client, me)); if (res.length < L.rungs.length) await sleep(5000); }
  console.log("5) resolved:"); for (const r of res) console.log(`   ${r.name} -> ${r.side.toUpperCase()}  oracle $${r.oraclePrice} @ ${r.oracleTs} (${r.oracleSource})`);
  const c = await k.claimResolved(client, me);
  console.log(`6) claims: ${c.filter((x) => x.signature).length} ok, ${c.filter((x) => x.skipped).length} skipped`);
  bal = await pm.balances(conn, me); console.log(`   builder now ${bal.sol.toFixed(3)} SOL, ${bal.usdc} mUSDC`);
})().catch((e) => { console.error("demo failed:", e.message || e); process.exit(1); });
