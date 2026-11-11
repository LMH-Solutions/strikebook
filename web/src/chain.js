// Browser-side devnet I/O for the trade panel: RPC pick, balances, faucets, market fetch, signed swap and claim.
// Loaded lazily (dynamic import) so the markets page and SSR tests never pull in web3.js. DEVNET ONLY.
import "./polyfill.js";
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, VersionedTransaction } from "@solana/web3.js";
import { AnchorProvider } from "@anchor-lang/core";
import { PmAmmClient, deriveYesMint, deriveNoMint } from "@pm-amm/sdk";
import { getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { assertDevnetRpc, loadBurner, loadOrCreateBurner, resetBurner, exportBurner } from "./wallet.js";

export const PROGRAM_ID = new PublicKey("GV1FMGHRYBjQLaghE5fnGuYCuCcpdt3GD5xEX3TwN16y");
export const MUSDC = new PublicKey("3WQ8hCqTNwjrh8WzE2XyoZoUrd1miPcwWfMkmFPUMEWZ"); // devnet mock USDC, 6 dp
export const FAUCET_URL = "https://pm-amm-devnet.vercel.app/api/faucet"; // 1000 mUSDC + 0.2 SOL, 1 claim / hour / wallet
export const DEVNET_RPCS = ["https://api.devnet.solana.com", "https://solana-devnet.api.onfinality.io/public", "https://devnet.rpcpool.com"];
export { Keypair };

async function pickRpc() {
  for (const url of DEVNET_RPCS) {
    try {
      const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, signal: AbortSignal.timeout(6000),
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getHealth" }) });
      if (r.ok && (await r.json()).result === "ok") return url;
    } catch {}
  }
  return DEVNET_RPCS[0];
}

// Wallet shim for AnchorProvider (Anchor's own Wallet class is Node-only).
const keypairWallet = (kp) => ({
  publicKey: kp.publicKey,
  signTransaction: async (tx) => { if (tx instanceof VersionedTransaction) tx.sign([kp]); else tx.partialSign(kp); return tx; },
  signAllTransactions: async (txs) => { for (const tx of txs) { if (tx instanceof VersionedTransaction) tx.sign([kp]); else tx.partialSign(kp); } return txs; },
});

// Confirm by polling (public devnet RPCs drop websockets), same as the keeper's pollingConfirm.
function pollingConfirm(conn, { intervalMs = 1500, timeoutMs = 90_000 } = {}) {
  conn.confirmTransaction = async (strategy, commitment = "confirmed") => {
    const sig = typeof strategy === "string" ? strategy : strategy.signature;
    const until = Date.now() + timeoutMs;
    for (;;) {
      let st = null;
      try { st = (await conn.getSignatureStatuses([sig])).value[0]; } catch {}
      if (st && st.err) return { context: { slot: st.slot }, value: { err: st.err } };
      if (st && (st.confirmationStatus === "confirmed" || st.confirmationStatus === "finalized")) return { context: { slot: st.slot }, value: { err: null } };
      if (Date.now() > until) throw new Error(`confirm timeout ${sig}`);
      await new Promise((r) => setTimeout(r, intervalMs));
    }
  };
  return conn;
}

// create=false: reuse a stored burner if there is one, else a read-only session (exact quotes, no signing).
export async function openSession(storage = globalThis.localStorage, { create = false } = {}) {
  const rpc = assertDevnetRpc(await pickRpc());
  const conn = pollingConfirm(new Connection(rpc, { commitment: "confirmed" }));
  const kp = create ? loadOrCreateBurner(storage, Keypair) : loadBurner(storage, Keypair);
  if (!kp) return { rpc, conn, kp: null, client: PmAmmClient.readOnly(conn, PROGRAM_ID, MUSDC), address: null };
  const provider = new AnchorProvider(conn, keypairWallet(kp), { commitment: "confirmed" });
  const client = PmAmmClient.fromProvider(provider, PROGRAM_ID, MUSDC);
  return { rpc, conn, kp, client, address: kp.publicKey.toBase58() };
}

export async function balances(s) {
  const sol = (await s.conn.getBalance(s.kp.publicKey)) / LAMPORTS_PER_SOL;
  let usdc = 0;
  try { usdc = Number((await s.conn.getTokenAccountBalance(getAssociatedTokenAddressSync(MUSDC, s.kp.publicKey))).value.uiAmount); } catch {}
  return { sol, usdc };
}

export async function faucet(s) {
  const res = await fetch(FAUCET_URL, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ wallet: s.address }) });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || body.ok === false) throw new Error(body.error || body.message || `faucet HTTP ${res.status}`);
  return body;
}
export async function airdropSol(s, sol = 0.5) {
  const sig = await s.conn.requestAirdrop(s.kp.publicKey, Math.round(sol * LAMPORTS_PER_SOL));
  await s.conn.confirmTransaction(sig);
  return sig;
}

export const fetchMarket = (s, market) => s.client.fetchMarket(new PublicKey(market));

// Signed buy: usdcToYes / usdcToNo with an exact quote's min-output bound (slippage guard enforced on-chain).
export async function buy(s, market, side, amountInRaw, minOutRaw) {
  if (!s.kp) throw new Error("no burner wallet");
  assertDevnetRpc(s.conn.rpcEndpoint);
  return s.client.send.swap(new PublicKey(market), side === "yes" ? "usdcToYes" : "usdcToNo", amountInRaw, minOutRaw);
}
// Signed sell (exit): yesToUsdc / noToUsdc of raw outcome tokens, min mUSDC out from the exact quote (1% slippage).
export async function sell(s, market, side, tokensRaw, minOutRaw) {
  if (!s.kp) throw new Error("no burner wallet");
  assertDevnetRpc(s.conn.rpcEndpoint);
  return s.client.send.swap(new PublicKey(market), side === "yes" ? "yesToUsdc" : "noToUsdc", tokensRaw, minOutRaw);
}
// Fetch many Market accounts in one getMultipleAccounts call (chunks of 100). Returns {market: decoded | null}.
export async function fetchMarkets(s, markets) {
  const out = {};
  for (let i = 0; i < markets.length; i += 100) {
    const chunk = markets.slice(i, i + 100);
    const accts = await s.client.accounts.market.fetchMultiple(chunk.map((m) => new PublicKey(m)));
    chunk.forEach((m, j) => { out[m] = accts[j] || null; });
  }
  return out;
}
export async function claim(s, market) {
  assertDevnetRpc(s.conn.rpcEndpoint);
  return s.client.send.claimWinnings(new PublicKey(market));
}

// Outcome-token holdings of the burner across the given markets ({market, name, ...} from the resolution log).
export async function positions(s, markets) {
  const res = await s.conn.getParsedTokenAccountsByOwner(s.kp.publicKey, { programId: TOKEN_PROGRAM_ID });
  const held = new Map(), raw = new Map();
  for (const { account } of res.value) {
    const info = account.data.parsed?.info;
    const amt = Number(info?.tokenAmount?.uiAmount || 0);
    if (amt > 0) { held.set(info.mint, amt); raw.set(info.mint, Number(info.tokenAmount.amount)); }
  }
  const out = [];
  for (const m of markets) {
    const pk = new PublicKey(m.market);
    const ym = deriveYesMint(PROGRAM_ID, pk).toBase58(), nm = deriveNoMint(PROGRAM_ID, pk).toBase58();
    const yes = held.get(ym) || 0, no = held.get(nm) || 0;
    if (yes > 0 || no > 0) out.push({ ...m, yes, no, yesRaw: raw.get(ym) || 0, noRaw: raw.get(nm) || 0 });
  }
  return out;
}

export const exportKey = (s) => exportBurner(s.kp);
export const reset = (storage = globalThis.localStorage) => resetBurner(storage);
