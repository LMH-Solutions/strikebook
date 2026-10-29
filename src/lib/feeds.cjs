// Read-only public price feeds. No keys, no signing.
const HERMES = process.env.HERMES_URL || "https://hermes.pyth.network";
// Pyth price feed IDs (Crypto.X/USD)
const PYTH_IDS = {
  SOL: "ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d",
  BTC: "e62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43",
  ETH: "ff61491a931112ddf1bd8147cd1b641375f79f82582524c3cfc4d7d0bb0cb1d7",
};

// Pyth sponsored PriceUpdateV2 accounts on Solana mainnet (shard 0). Read-only.
const PYTH_ACCOUNTS = {
  SOL: "7UVimffxr9ow1uXYxsr4LHAcV58mLzhmwaeKvJ1pjLiE",
  BTC: "4cSM2e6rvbGQUFiJbqytoVMi5GgghSMr8LwVrT9VPSPo",
  // ETH: TODO look up correct shard-0 account (42amVS4K... returned a different feed id)
};
const MAINNET_RPC = process.env.MAINNET_RPC_URL || "https://api.mainnet-beta.solana.com";

function decodePriceUpdateV2(buf) {
  // 8 discriminator | 32 write_authority | verification_level (1 byte Full, 2 bytes Partial)
  let o = 40;
  o += buf[o] === 1 ? 1 : 2;
  const feedId = buf.subarray(o, o + 32).toString("hex"); o += 32;
  const price = buf.readBigInt64LE(o); o += 8;
  const conf = buf.readBigUInt64LE(o); o += 8;
  const expo = buf.readInt32LE(o); o += 4;
  const publishTime = Number(buf.readBigInt64LE(o));
  const scale = 10 ** expo;
  return { feedId, price: Number(price) * scale, conf: Number(conf) * scale, expo, publishTime };
}

async function pythLatest(asset) {
  const acct = PYTH_ACCOUNTS[asset];
  if (!acct) throw new Error(`unknown asset ${asset}`);
  try {
    const res = await fetch(MAINNET_RPC, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getAccountInfo", params: [acct, { encoding: "base64" }] }) });
    const j = await res.json();
    const d = decodePriceUpdateV2(Buffer.from(j.result.value.data[0], "base64"));
    if (d.feedId !== PYTH_IDS[asset]) throw new Error("feed id mismatch");
    return { asset, ...d, source: `pyth-onchain ${acct}` };
  } catch (e) {
    // Fallback: Hermes (now needs an API key: set HERMES_API_KEY)
    const res = await fetch(`${HERMES}/v2/updates/price/latest?ids[]=${PYTH_IDS[asset]}&parsed=true`,
      { headers: process.env.HERMES_API_KEY ? { "x-api-key": process.env.HERMES_API_KEY } : {} });
    if (!res.ok) throw new Error(`pyth on-chain failed (${e.message}); hermes ${res.status}`);
    const p = (await res.json()).parsed[0].price;
    return { asset, price: Number(p.price) * 10 ** p.expo, conf: Number(p.conf) * 10 ** p.expo, publishTime: p.publish_time, source: "pyth-hermes" };
  }
}

// Historical price at/near a timestamp (used by the resolver keeper).
// Pyth Hermes historical (needs HERMES_API_KEY since late 2026); falls back to the
// Coinbase 1-minute candle close containing unixTs so the dry-run keeper still works.
async function pythAt(asset, unixTs) {
  const id = PYTH_IDS[asset];
  if (process.env.HERMES_API_KEY) {
    const res = await fetch(`${HERMES}/v2/updates/price/${unixTs}?ids[]=${id}&parsed=true`, { headers: { "x-api-key": process.env.HERMES_API_KEY } });
    if (res.ok) {
      const p = (await res.json()).parsed[0].price;
      return { price: Number(p.price) * 10 ** p.expo, publishTime: p.publish_time, source: "pyth-hermes" };
    }
  }
  const start = new Date((unixTs - 60) * 1000).toISOString(), end = new Date((unixTs + 60) * 1000).toISOString();
  const res = await fetch(`https://api.exchange.coinbase.com/products/${asset}-USD/candles?granularity=60&start=${start}&end=${end}`, { headers: { "user-agent": "strikebook" } });
  if (!res.ok) throw new Error(`coinbase ${res.status}`);
  const rows = await res.json();
  const row = rows.find((r) => r[0] <= unixTs && unixTs < r[0] + 60) || rows[0];
  if (!row) throw new Error("no candle");
  return { price: row[4], publishTime: row[0] + 60, source: "coinbase-1m-fallback" };
}

// Hourly closes for realised vol (Coinbase public candles, no auth).
async function hourlyCloses(asset, n = 168) {
  const res = await fetch(`https://api.exchange.coinbase.com/products/${asset}-USD/candles?granularity=3600`, { headers: { "user-agent": "strikebook" } });
  if (!res.ok) throw new Error(`coinbase ${res.status}`);
  const rows = await res.json(); // [time, low, high, open, close, volume] newest first
  return rows.slice(0, n).reverse().map((r) => r[4]);
}

module.exports = { decodePriceUpdateV2, PYTH_ACCOUNTS, pythLatest, pythAt, hourlyCloses, PYTH_IDS };
