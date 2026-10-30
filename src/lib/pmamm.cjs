// pm-AMM glue: devnet constants, read-only / signing clients, throwaway devnet keypair,
// faucet, and a CJS port of the official pm-amm-helpers (marketState, quoteSwap, minOutput).
// DEVNET ONLY. The same program id runs on mainnet with real USDC: never point this at mainnet.
const fs = require("fs");
const path = require("path");
const { Connection, Keypair, PublicKey } = require("@solana/web3.js");
const { capitalPhi, i80f48ToNumber, phi } = require("@pm-amm/sdk/math");

const PROGRAM_ID = new PublicKey("GV1FMGHRYBjQLaghE5fnGuYCuCcpdt3GD5xEX3TwN16y");
const MUSDC = new PublicKey("3WQ8hCqTNwjrh8WzE2XyoZoUrd1miPcwWfMkmFPUMEWZ"); // devnet mock USDC, 6 dp
const RPC = process.env.RPC_URL || "https://api.devnet.solana.com";
const APP = "https://pm-amm-devnet.vercel.app";
const KEY_FILE = process.env.DEVNET_KEYPAIR || path.join(__dirname, "../../../.devnet-keys/builder.json");

function assertDevnet(rpc = RPC) {
  if (/mainnet/i.test(rpc) && !process.env.I_KNOW_THIS_IS_MAINNET) throw new Error(`refusing to sign against ${rpc}: devnet only`);
}
const connection = (rpc = RPC) => new Connection(rpc, "confirmed");

function loadKeypair(file = KEY_FILE) {
  if (!fs.existsSync(file)) {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const kp = Keypair.generate();
    fs.writeFileSync(file, JSON.stringify(Array.from(kp.secretKey)), { mode: 0o600 });
  }
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(file, "utf8"))));
}

function readOnlyClient(conn = connection()) {
  const { PmAmmClient } = require("@pm-amm/sdk");
  return PmAmmClient.readOnly(conn, PROGRAM_ID, MUSDC);
}
function signingClient(kp = loadKeypair(), conn = connection()) {
  assertDevnet();
  const { AnchorProvider, Wallet } = require("@anchor-lang/core");
  const { PmAmmClient } = require("@pm-amm/sdk");
  const provider = new AnchorProvider(conn, new Wallet(kp), { commitment: "confirmed" });
  return PmAmmClient.fromProvider(provider, PROGRAM_ID, MUSDC);
}

async function faucet(pubkey) {
  const res = await fetch(`${APP}/api/faucet`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ wallet: pubkey.toBase58() }) });
  const body = await res.json().catch(() => ({}));
  return { status: res.status, ...body };
}

async function balances(conn, owner) {
  const { getAssociatedTokenAddressSync } = require("@solana/spl-token");
  const sol = (await conn.getBalance(owner)) / 1e9;
  let usdc = 0;
  try { usdc = Number((await conn.getTokenAccountBalance(getAssociatedTokenAddressSync(MUSDC, owner))).value.uiAmount); } catch {}
  return { sol, usdc };
}

const decodeName = (n) => Buffer.from(n).toString("utf8").replace(/\0+$/, "");
const toNum = (v) => (v && typeof v.toNumber === "function" ? v.toNumber() : Number(v));

// ---- port of predict-pm-amm.dev/helpers/pm-amm-helpers.ts ----
const FEE_BPS = 200;
const Z_CLAMP = 5.9;
function marketState(m, now = Math.floor(Date.now() / 1000)) {
  const endTs = toNum(m.endTs);
  const lZero = i80f48ToNumber(m.lZero);
  const secondsLeft = Math.max(endTs - now, 0);
  const lEff = lZero * Math.sqrt(Math.max(endTs - now, 1));
  const lLast = lZero * Math.sqrt(Math.max(endTs - toNum(m.lastAccrualTs), 1));
  const scale = lLast > 0 ? lEff / lLast : 0;
  const x = i80f48ToNumber(m.reserveYes) * scale;
  const y = i80f48ToNumber(m.reserveNo) * scale;
  const winner = m.winningSide === 1 ? "yes" : m.winningSide === 2 ? "no" : null;
  const price = winner ? (winner === "yes" ? 1 : 0) : lEff > 0 ? capitalPhi((y - x) / lEff) : 0.5;
  return { x, y, lEff, price, secondsLeft, expired: secondsLeft === 0, resolved: !!m.resolved, winner };
}
const base = (u) => u * capitalPhi(u) + phi(u);
function solveU(f, target, increasing) {
  let lo = -40, hi = 40;
  for (let i = 0; i < 200; i++) { const mid = (lo + hi) / 2; const v = f(mid); if (increasing ? v < target : v > target) lo = mid; else hi = mid; }
  return (lo + hi) / 2;
}
const xFromY = (y, L) => y - L * solveU(base, y / L, true);
const yFromX = (x, L) => x + solveU((v) => base(v) - v, x / L, false) * L;
function curveOut(s, dir, dIn) {
  const { x, y, lEff: L } = s;
  const clampZ = (z) => Math.max(-Z_CLAMP, Math.min(Z_CLAMP, z));
  switch (dir) {
    case "usdcToYes": return dIn + (x - xFromY(y + dIn, L));
    case "usdcToNo": return dIn + (y - yFromX(x + dIn, L));
    case "yesToUsdc": return y - L * base(clampZ((y - x - dIn) / L));
    case "noToUsdc": { const z = clampZ((y - x + dIn) / L); return x - L * (base(z) - z); }
    case "yesToNo": return y - yFromX(x + dIn, L);
    case "noToYes": return x - xFromY(y + dIn, L);
    default: throw new Error(`bad direction ${dir}`);
  }
}
function quoteSwapState(s, direction, amountIn) {
  if (s.resolved || s.expired) throw new Error("market is resolved or expired: no swaps");
  const usdcIn = direction === "usdcToYes" || direction === "usdcToNo";
  const usdcOut = direction === "yesToUsdc" || direction === "noToUsdc";
  const feeIn = usdcIn ? Math.floor((amountIn * FEE_BPS) / 10_000) : 0;
  const gross = Math.max(Math.floor(curveOut(s, direction, amountIn - feeIn)), 0);
  const feeOut = usdcOut ? Math.floor((gross * FEE_BPS) / 10_000) : 0;
  const out = gross - feeOut;
  return { out, fee: feeIn + feeOut, avgPrice: amountIn > 0 ? out / amountIn : 0 };
}
const quoteSwap = (m, direction, amountIn, now) => quoteSwapState(marketState(m, now), direction, amountIn);
const minOutput = (q, slippageBps = 100) => Math.floor((q.out * (10_000 - slippageBps)) / 10_000);

module.exports = { PROGRAM_ID, MUSDC, RPC, APP, KEY_FILE, assertDevnet, connection, loadKeypair, readOnlyClient, signingClient,
  faucet, balances, decodeName, toNum, marketState, quoteSwap, quoteSwapState, minOutput, FEE_BPS };
