#!/usr/bin/env node
// Read-only: list live pm-AMM markets on devnet with their current price. No wallet needed.
const { Connection, PublicKey } = require("@solana/web3.js");
const { PmAmmClient } = require("@pm-amm/sdk");
const { marketState } = require("../lib/pmamm.cjs");
const { parseStrikeName } = require("../lib/resolver.cjs");

const PROGRAM_ID = new PublicKey("GV1FMGHRYBjQLaghE5fnGuYCuCcpdt3GD5xEX3TwN16y");
const MUSDC = new PublicKey("3WQ8hCqTNwjrh8WzE2XyoZoUrd1miPcwWfMkmFPUMEWZ");

(async () => {
  const conn = new Connection(process.env.RPC_URL || "https://api.devnet.solana.com", "confirmed");
  const client = PmAmmClient.readOnly(conn, PROGRAM_ID, MUSDC);
  const all = await client.fetchAllMarkets(443);
  const now = Date.now() / 1000;
  const rows = all.map(({ publicKey, account: a }) => {
    const name = Buffer.isBuffer(a.name) || Array.isArray(a.name) ? Buffer.from(a.name).toString("utf8").replace(/\0+$/, "") : String(a.name ?? "");
    let price = null;
    try { price = +marketState(a).price.toFixed(4); } catch {}
    const endTs = Number(a.endTs?.toString?.() ?? a.endTs);
    return { market: publicKey.toBase58(), name, endTs, live: endTs > now && !a.resolved, price, strike: parseStrikeName(name) };
  });
  const live = rows.filter((r) => r.live);
  console.log(JSON.stringify({ total: rows.length, live: live.length, liveMarkets: live.slice(0, 20) }, null, 2));
})().catch((e) => { console.error(e.message || e); process.exit(1); });
