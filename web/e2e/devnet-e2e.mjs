// Headless-Chrome E2E for the StrikeBook front end against REAL Solana devnet (play money only).
//   node e2e/devnet-e2e.mjs [URL] [--trade] [--both] [--sell-frac=0.5] [--market=<pk>] [--claim]
// URL defaults to http://localhost:8765/app/ (serve ../docs with any static server, e.g. `python3 -m http.server 8765 -d ../docs`).
// --trade: create (or reuse) the in-page burner, faucet if low, buy YES 10 mUSDC on the soonest rung (or --market),
//          then sell --sell-frac of the YES position from the Positions table. --both also buys NO 10 on the same rung,
//          so one side is guaranteed to win and the claim can be checked after resolution.
// --claim: click every Claim button in Positions (run after the rung resolved, with the same PROFILE).
// --wallet=mock-phantom: instead of the burner, inject a fake window.phantom.solana whose signTransaction is backed by a
//          throwaway ed25519 key held in this Node process (never in the page). Exercises the injected-wallet path
//          (Phantom/Backpack adapter) end to end on devnet without a browser extension.
// BURNER_KEY_FILE=<Solana CLI JSON>: preload that devnet burner into the page's localStorage (any origin, e.g. the live
//          Pages site), so a position bought in an earlier run can be checked or claimed later.
// Every tx signature from the page's status line is then polled on devnet until finalized; the run fails unless err is null.
// The burner lives in the Chrome profile's localStorage (PROFILE env, default a fresh /tmp dir). DEVNET ONLY: the page
// itself refuses non-devnet RPCs (assertDevnetRpc) and this script only queries api.devnet.solana.com.
import puppeteer from "puppeteer-core";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { PublicKey } from "@solana/web3.js";

const args = process.argv.slice(2);
const flag = (n) => args.includes(`--${n}`);
const opt = (n, d) => (args.find((a) => a.startsWith(`--${n}=`)) || "").split("=")[1] || d;
const URL = args.find((a) => !a.startsWith("--")) || "http://localhost:8765/app/";
const RPC = "https://api.devnet.solana.com";
if (!/devnet/.test(RPC)) throw new Error("devnet only");
const PROFILE = process.env.PROFILE || fs.mkdtempSync(path.join(os.tmpdir(), "strikebook-e2e-"));
const CHROME = process.env.CHROME || "/usr/bin/google-chrome";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const t0 = Date.now(), log = (...a) => console.error(`[${((Date.now() - t0) / 1000).toFixed(1)}s]`, ...a);

async function rpc(method, params) {
  const r = await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  return (await r.json()).result;
}
async function finalized(sig, timeoutMs = 120_000) {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const st = (await rpc("getSignatureStatuses", [[sig], { searchTransactionHistory: true }]).catch(() => null))?.value?.[0];
    if (st && st.confirmationStatus === "finalized") return { sig, slot: st.slot, err: st.err };
    if (Date.now() > until) return { sig, err: "timeout", status: st?.confirmationStatus ?? null };
    await sleep(3000);
  }
}

const browser = await puppeteer.launch({ executablePath: CHROME, headless: "new", args: ["--no-sandbox"], userDataDir: PROFILE });
const out = { url: URL, profile: PROFILE, startedAt: new Date().toISOString(), steps: [], txs: [] };
const errs = [];
try {
  const page = await browser.newPage();
  page.on("console", (m) => { if (m.type() === "error" && !/favicon/.test(m.text())) errs.push(m.text()); });
  page.on("pageerror", (e) => errs.push("pageerror " + e.message));
  page.on("dialog", (d) => d.accept());
  await page.setViewport({ width: 1300, height: 1800 });
  const MOCK = opt("wallet", "burner") === "mock-phantom";
  if (process.env.BURNER_KEY_FILE && !MOCK) {
    const secret = fs.readFileSync(process.env.BURNER_KEY_FILE, "utf8").trim();
    await page.evaluateOnNewDocument((k) => { if (!localStorage.getItem("strikebook.devnet-burner.v1")) localStorage.setItem("strikebook.devnet-burner.v1", k); }, secret);
  }
  if (MOCK) { // throwaway devnet key in Node; the page only ever sees signatures
    const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
    const addr = new PublicKey(Buffer.from(publicKey.export({ format: "jwk" }).x, "base64url")).toBase58();
    out.mockWallet = addr;
    await page.exposeFunction("__mockSign", (msg) => Array.from(crypto.sign(null, Buffer.from(msg), privateKey)));
    await page.evaluateOnNewDocument((addr) => {
      const pk = { toString: () => addr, toBase58: () => addr };
      const signTransaction = async (tx) => { const sig = await window.__mockSign(Array.from(tx.serializeMessage())); tx.addSignature(tx.feePayer, Uint8Array.from(sig)); window.__mockSigned = (window.__mockSigned || 0) + 1; return tx; };
      window.phantom = { solana: { isPhantom: true, publicKey: pk, connect: async () => ({ publicKey: pk }), disconnect: async () => {}, signTransaction,
        signAllTransactions: async (txs) => { for (const t of txs) await signTransaction(t); return txs; } } };
    }, addr);
  }
  await page.goto(URL, { waitUntil: "networkidle0", timeout: 60000 });
  await page.waitForSelector(".ladder tbody tr", { timeout: 30000 });
  const txt = (sel) => page.$eval(sel, (e) => e.innerText).catch(() => null);
  const status = () => txt(".wallet .status");
  const waitStatus = async (re, ms = 150000) => {
    await page.waitForFunction((src) => new RegExp(src).test(document.querySelector(".wallet .status")?.innerText || ""), { timeout: ms }, re.source);
    return status();
  };
  const sigOf = (s) => (String(s).match(/tx ([1-9A-HJ-NP-Za-km-z]{60,90})/) || [])[1] || null;
  out.title = await page.title();
  out.rungs = await page.$$eval(".ladder tbody tr", (rs) => rs.map((r) => ({ market: r.dataset.market, end: Number(r.dataset.end), text: r.innerText.replace(/\s+/g, " ") })));
  await page.waitForSelector(".ladder .live", { timeout: 45000 }).then(() => (out.livePrices = true)).catch(() => (out.livePrices = false));
  out.liveNote = await page.$$eval(".ladder p.small", (p) => p.map((x) => x.innerText)).catch(() => []);

  // burner
  if (MOCK) {
    await page.waitForSelector(".wallet button.connect", { timeout: 30000 });
    await page.click(".wallet button.connect"); out.steps.push("connected mock Phantom");
  } else {
    const hasKp = await page.evaluate(() => !!localStorage.getItem("strikebook.devnet-burner.v1"));
    if (!hasKp) { await page.click(".wallet button.cta"); out.steps.push("created burner"); }
  }
  await page.waitForFunction(() => document.querySelector(".wallet")?.innerText.includes("Address"), { timeout: 60000 });
  out.wallet = await page.$eval(".wallet h2", (h) => h.innerText);
  out.burner = await page.$eval(".wallet dd a", (a) => a.title);
  if (MOCK && out.burner !== out.mockWallet) throw new Error("page did not pick up the injected wallet");
  const bal = async () => { await sleep(2500); const d = await page.$$eval(".wallet dd", (x) => x.map((y) => y.innerText)); return { sol: Number(d[1]), usdc: Number(d[2]) }; };
  out.balStart = await bal();

  if (flag("trade")) {
    const need = flag("both") ? 20 : 10;
    if (!(out.balStart.usdc >= need) || !(out.balStart.sol >= 0.02)) {
      const [fb] = await page.$$(".wallet .seg button"); await fb.click();
      out.faucet = await waitStatus(/Faucet:|failed/, 90000); log("faucet:", out.faucet);
      if (/failed/.test(out.faucet)) throw new Error("faucet " + out.faucet);
      await sleep(4000);
      const btns = await page.$$(".wallet .seg button"); await btns[2].click();
    }
    out.balAfterFaucet = await bal();
    const now = Date.now() / 1000;
    const pick = opt("market", null) || out.rungs.filter((r) => r.end - now > 15 * 60).sort((a, b) => a.end - b.end)[0]?.market;
    if (!pick) throw new Error("no rung with >15 min left");
    out.market = pick;
    await page.click(`.ladder tbody tr[data-market="${pick}"]`);
    for (const side of flag("both") ? ["yes", "no"] : ["yes"]) {
      await page.$$eval(".trade .seg button", (bs, s) => bs.find((b) => b.innerText.toLowerCase() === `buy ${s}`)?.click(), side);
      await page.waitForFunction(() => document.querySelector(".trade")?.innerText.includes("Tokens (exact)"), { timeout: 45000 });
      out[`quote_${side}`] = await page.$$eval(".trade dl dd", (d) => d.map((x) => x.innerText));
      await page.waitForFunction(() => { const b = document.querySelector("button.cta.buy"); return b && !b.disabled; }, { timeout: 60000 });
      await page.click("button.cta.buy");
      const st = await waitStatus(/Bought|failed/); log("buy:", st);
      out.steps.push(st);
      if (/failed/.test(st)) throw new Error(st);
      out.txs.push({ kind: `buy ${side}`, sig: sigOf(st) });
      await sleep(3000);
    }
    // sell part of the YES position from the Positions table
    const rowSel = `.positions tr[data-market="${pick}"]`;
    await page.waitForSelector(`${rowSel} button.sell`, { timeout: 60000 });
    await sleep(2000);
    out.positionBefore = await txt(rowSel);
    const sel = await page.$(`${rowSel} select`);
    if (sel) await sel.select("yes");
    const held = Number(await page.$eval(`${rowSel} input[aria-label="sell amount"]`, (i) => i.placeholder));
    const frac = Number(opt("sell-frac", "0.5"));
    const qty = Math.floor(held * frac * 100) / 100;
    await page.type(`${rowSel} input[aria-label="sell amount"]`, String(qty));
    await page.waitForFunction((rs) => { const b = document.querySelector(`${rs} button.sell`); return b && !b.disabled && /→/.test(document.querySelector(`${rs} .quote`)?.innerText || ""); }, { timeout: 60000 }, rowSel);
    out.sellQuote = await txt(`${rowSel} .quote`);
    await page.click(`${rowSel} button.sell`);
    const st = await waitStatus(/Sold|failed/); log("sell:", st);
    out.steps.push(st);
    if (/failed/.test(st)) throw new Error(st);
    out.txs.push({ kind: `sell yes ${qty}`, sig: sigOf(st) });
    await sleep(8000);
    out.positionAfter = await txt(rowSel);
  }
  if (flag("positions")) { // read-only: wait for the Positions table and report it
    await page.waitForSelector(".positions table, .positions p", { timeout: 60000 }); await sleep(5000);
    out.positionsTable = await txt(".positions");
  }
  if (flag("claim")) {
    await page.waitForSelector(".positions", { timeout: 60000 });
    await sleep(6000);
    out.positionsBeforeClaim = await txt(".positions");
    for (;;) {
      const b = await page.$(".positions button.claim:not([disabled])");
      if (!b) break;
      await b.click();
      const st = await waitStatus(/Claimed|failed/); log("claim:", st);
      out.steps.push(st);
      if (/failed/.test(st)) throw new Error(st);
      out.txs.push({ kind: "claim", sig: sigOf(st) });
      await sleep(6000);
    }
    if (!out.txs.some((t) => t.kind === "claim")) out.steps.push("no claimable position");
    out.positionsAfterClaim = await txt(".positions");
  }
  out.balEnd = await bal();
  if (MOCK) out.mockSignatures = await page.evaluate(() => window.__mockSigned || 0);
  out.calibDots = (await page.$$(".calib circle")).length;
  await page.screenshot({ path: process.env.SHOT || path.join(PROFILE, "e2e.png"), fullPage: true });
  for (const t of out.txs) Object.assign(t, await finalized(t.sig));
} catch (e) {
  out.failure = String(e?.message || e);
} finally {
  out.errors = errs;
  out.ok = !out.failure && out.txs.every((t) => t.sig && t.err === null) && (!flag("trade") || out.txs.length > 0);
  console.log(JSON.stringify(out, null, 2));
  await browser.close();
  process.exitCode = out.ok ? 0 : 1;
}
