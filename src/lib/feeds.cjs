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
const ONCHAIN_WINDOW = Number(process.env.PYTH_ONCHAIN_WINDOW || 90); // secs after endTs we trust the live account
const settleCache = new Map(); // `${asset}:${ts}` -> settlement print, so every rung of a ladder settles on ONE print
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Settlement price for `asset` at `unixTs`. Order of preference:
//  1) live on-chain Pyth account, first publish_time >= unixTs (retried for a few seconds), if we're inside the window
//  2) Pyth Hermes historical (HERMES_API_KEY)
//  3) Coinbase 1m candle close, ONLY once that candle has closed (else throws "not-final" and the keeper retries)
async function pythAt(asset, unixTs, nowTs = Math.floor(Date.now() / 1000), { latest = pythLatest, retries = 5, retryMs = 1500 } = {}) {
  const key = `${asset}:${unixTs}`;
  if (settleCache.has(key)) return settleCache.get(key);
  const keep = (v) => (settleCache.set(key, v), v);
  const id = PYTH_IDS[asset];
  if (nowTs >= unixTs && nowTs - unixTs <= ONCHAIN_WINDOW && PYTH_ACCOUNTS[asset]) {
    for (let i = 0; i <= retries; i++) {
      try {
        const p = await latest(asset);
        if (p.source.startsWith("pyth-onchain") && p.publishTime >= unixTs && p.publishTime - unixTs <= ONCHAIN_WINDOW)
          return keep({ price: p.price, conf: p.conf, publishTime: p.publishTime, source: p.source });
        if (p.publishTime - unixTs > ONCHAIN_WINDOW) break;
      } catch {}
      if (i < retries) await sleep(retryMs);
    }
  }
  if (process.env.HERMES_API_KEY) {
    const res = await fetch(`${HERMES}/v2/updates/price/${unixTs}?ids[]=${id}&parsed=true`, { headers: { "x-api-key": process.env.HERMES_API_KEY } });
    if (res.ok) {
      const p = (await res.json()).parsed[0].price;
      return keep({ price: Number(p.price) * 10 ** p.expo, conf: Number(p.conf) * 10 ** p.expo, publishTime: p.publish_time, source: "pyth-hermes" });
    }
  }
  const minute = Math.floor(unixTs / 60) * 60;
  if (Math.floor(Date.now() / 1000) < minute + 75) throw new Error("not-final: fallback candle still open");
  const start = new Date((minute - 60) * 1000).toISOString(), end = new Date((minute + 60) * 1000).toISOString();
  const res = await fetch(`https://api.exchange.coinbase.com/products/${asset}-USD/candles?granularity=60&start=${start}&end=${end}`, { headers: { "user-agent": "strikebook" } });
  if (!res.ok) throw new Error(`coinbase ${res.status}`);
  const row = (await res.json()).find((r) => r[0] === minute);
  if (!row) throw new Error("not-final: no candle for that minute");
  return keep({ price: row[4], conf: null, publishTime: minute + 60, source: "coinbase-1m-fallback" });
}

// Hourly closes for realised vol (Coinbase public candles, no auth).
async function hourlyCloses(asset, n = 168) {
  const res = await fetch(`https://api.exchange.coinbase.com/products/${asset}-USD/candles?granularity=3600`, { headers: { "user-agent": "strikebook" } });
  if (!res.ok) throw new Error(`coinbase ${res.status}`);
  const rows = await res.json(); // [time, low, high, open, close, volume] newest first
  return rows.slice(0, n).reverse().map((r) => r[4]);
}

module.exports = { decodePriceUpdateV2, PYTH_ACCOUNTS, pythLatest, pythAt, hourlyCloses, PYTH_IDS };
