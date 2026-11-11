import { useCallback, useEffect, useMemo, useState } from "react";
import { groupLadders, modelYes, quotePreview, suggestedSide, fmtLeft, pct, money, calibrationPoints, buyBlocker, positionRows, sellBlocker, withLivePrices } from "./model.js";
import { marketState, exactBuyQuote, exactSellQuote, livePrices } from "./amm.js";
import { KEY as BURNER_KEY, shortAddr } from "./wallet.js";

export const LOG_URL = import.meta.env?.VITE_LOG_URL || "../resolution-log.json";
const solscan = (sig, cl) => `https://solscan.io/tx/${sig}?cluster=${cl}`;
const nowSecs = () => Math.floor(Date.now() / 1000);
const solscanAcct = (a, cl) => `https://solscan.io/account/${a}?cluster=${cl}`;
const loadChain = () => import("./chain.js"); // web3.js + Anchor only load in the browser, after first paint
const errMsg = (e) => String(e?.message || e).split("\n")[0].slice(0, 160);

// Devnet session: read-only until a burner exists; then signing with the burner kept in localStorage.
export function useDevnet() {
  const [s, setS] = useState(null);
  const [bal, setBal] = useState(null);
  const [msg, setMsg] = useState(null);
  const [busy, setBusy] = useState(false);
  const open = useCallback(async (create = false) => {
    const chain = await loadChain();
    const sess = await chain.openSession(globalThis.localStorage, { create });
    setS({ ...sess, chain });
    setBal(sess.owner ? await chain.balances(sess).catch(() => null) : null);
    return sess;
  }, []);
  const connect = useCallback(async (entry) => {
    const chain = await loadChain();
    const sess = await chain.openInjectedSession(entry);
    setS({ ...sess, chain });
    setBal(await chain.balances(sess).catch(() => null));
    return sess;
  }, []);
  useEffect(() => { if (typeof window !== "undefined") open(false).catch((e) => setMsg("RPC: " + errMsg(e))); }, [open]);
  const refresh = useCallback(async () => { if (s?.owner) setBal(await s.chain.balances(s).catch(() => null)); }, [s]);
  const act = useCallback(async (label, fn) => {
    setBusy(true); setMsg(label + "…");
    try { const r = await fn(); setMsg(r); } catch (e) { setMsg(label + " failed: " + errMsg(e)); } finally { setBusy(false); }
  }, []);
  return { s, bal, msg, setMsg, busy, open, connect, refresh, act };
}

// Live YES prices for the open markets, read straight from the Market accounts (one getMultipleAccounts call every
// 20 s and after each trade), so the list doesn't lag the keeper log (which only refreshes every 15 min).
export function useLivePrices(sess, open, bump) {
  const [live, setLive] = useState(null);
  const keys = open.map((m) => m.market).join(",");
  useEffect(() => {
    if (!sess || !keys) return;
    let on = true;
    const load = () => sess.chain.fetchMarkets(sess, keys.split(",")).then((a) => on && setLive({ at: nowSecs(), prices: livePrices(a, nowSecs()) })).catch(() => {});
    load(); const t = setInterval(load, 20000);
    return () => { on = false; clearInterval(t); };
  }, [sess, keys, bump]);
  return live;
}

export function WalletPanel({ dev, cluster }) {
  const { s, bal, msg, busy, open, connect, refresh, act } = dev;
  const [shown, setShown] = useState(false);
  const [injected, setInjected] = useState([]);
  useEffect(() => { // wallets inject after load; look twice
    const look = () => s?.chain?.detectInjected && setInjected(s.chain.detectInjected(window));
    look(); const t = setTimeout(look, 1500); return () => clearTimeout(t);
  }, [s?.chain]);
  const hasStored = typeof localStorage !== "undefined" && !!localStorage.getItem(BURNER_KEY);
  const isBurner = s?.wallet === "burner";
  return (
    <section className="wallet">
      <h2>{s?.owner && !isBurner ? `${s.wallet} wallet` : "Burner wallet"} <span className="tag warn">DEVNET ONLY</span></h2>
      <p className="muted small">{s?.owner && !isBurner ? <>Signing with {s.wallet}; transactions go to Solana devnet through this page&apos;s devnet RPC. Switch the wallet to devnet/testnet mode so its balances match. Play money only.</>
        : <>A throwaway keypair generated in this page and stored in this browser&apos;s localStorage. Play money on Solana devnet: never send real funds to it.</>}</p>
      {!s?.owner ? (<>
        <button type="button" className="cta" disabled={busy || (!s && hasStored)} onClick={() => act("Creating burner", async () => { await open(true); return "Burner created. Use the faucet for 1000 mUSDC + 0.2 SOL."; })}>
          {hasStored && !s ? "Loading burner…" : "Create devnet burner wallet"}</button>
        {injected.length ? <div className="seg">{injected.map((w) => (
          <button key={w.id} type="button" className="connect" disabled={busy} onClick={() => act(`Connecting ${w.name}`, async () => { await connect(w); return `${w.name} connected (devnet RPC). Use the faucet for mUSDC + SOL.`; })}>Connect {w.name}</button>))}</div>
          : <p className="muted small">Or use Phantom / Backpack: none detected in this browser.</p>}
      </>) : (
        <>
          <dl>
            <dt>Address</dt><dd><a href={solscanAcct(s.address, cluster)} target="_blank" rel="noreferrer" title={s.address}>{shortAddr(s.address)}</a></dd>
            <dt>devnet SOL</dt><dd>{bal ? bal.sol.toFixed(4) : "–"}</dd>
            <dt>mUSDC</dt><dd>{bal ? bal.usdc.toFixed(2) : "–"}</dd>
          </dl>
          <div className="seg">
            <button type="button" disabled={busy} onClick={() => act("Faucet", async () => { const r = await s.chain.faucet(s); await new Promise((z) => setTimeout(z, 3000)); await refresh(); return `Faucet: +${r.amount ?? "?"} mUSDC, +${r.sol ?? "?"} SOL`; })}>Faucet (mUSDC + SOL)</button>
            <button type="button" disabled={busy} onClick={() => act("SOL airdrop", async () => { await s.chain.airdropSol(s, 0.5); await refresh(); return "Airdropped 0.5 devnet SOL"; })}>SOL airdrop</button>
            <button type="button" disabled={busy} title="refresh balances" onClick={() => act("Refresh", async () => { await refresh(); return null; })}>↻</button>
          </div>
          {!isBurner ? <div className="seg"><button type="button" disabled={busy} onClick={() => { s.injected?.disconnect?.().catch?.(() => {}); dev.setMsg(`${s.wallet} disconnected.`); open(false); }}>Disconnect</button></div> : <div className="seg">
            <button type="button" onClick={() => setShown(!shown)}>{shown ? "Hide key" : "Export key"}</button>
            <button type="button" disabled={busy} onClick={() => { if (globalThis.confirm?.("Delete this devnet burner from the browser? Export it first if you want to keep its balance.")) { s.chain.reset(); dev.setMsg("Burner deleted."); open(false); } }}>Reset</button>
          </div>}
          {shown && isBurner && <textarea readOnly className="key" value={s.chain.exportKey(s)} aria-label="burner secret key (Solana CLI JSON)" />}
        </>
      )}
      {msg && <p className="small status">{msg}</p>}
      {s && <p className="muted small">RPC {new URL(s.rpc).host}</p>}
    </section>
  );
}


export function Kpis({ log }) {
  const s = log.stats, T = s.traction || {};
  return (
    <div className="kpi">
      <div><b>{(log.open || []).length}</b>open markets</div>
      <div><b>{s.resolved}</b>resolved ({s.yes} YES / {s.no} NO)</div>
      <div><b>{s.brier ?? "–"}</b>Brier vs {s.brierCoinFlip} coin flip</div>
      <div><b>{T.trades ?? 0}</b>trades</div>
      <div><b>{Number(T.volumeUsdc || 0).toFixed(0)}</b>volume (mUSDC)</div>
    </div>
  );
}

export function MarketsList({ open, asset, now, selected, onSelect, liveAt = null }) {
  const ladders = groupLadders(open, asset);
  if (!ladders.length) return <p className="muted">No open markets right now. The keeper rolls a new ladder on the next 6h grid slot.</p>;
  return ladders.map((L) => (
    <section key={L.asset + L.endTs} className="ladder">
      <h3>{L.asset} · expires {new Date(L.endTs * 1000).toISOString().slice(0, 16).replace("T", " ")}Z <span className="muted">({fmtLeft(L.endTs - now)})</span></h3>
      <table>
        <thead><tr><th>Strike</th><th>AMM YES</th><th>Model YES</th><th>Edge</th><th>Trades</th><th></th></tr></thead>
        <tbody>
          {L.rungs.map((m) => {
            const p = modelYes(m, now);
            const side = suggestedSide(p, m.amm.yes);
            return (
              <tr key={m.market} data-market={m.market} data-end={m.endTs} className={selected === m.market ? "sel" : ""} onClick={() => onSelect(m.market)}>
                <td>{money(m.strike, m.asset)}</td>
                <td className="amm" title={m.amm.live ? `live on-chain price (keeper log: ${pct(m.amm.logYes)})` : "from the keeper log"}>{pct(m.amm.yes)}{m.amm.live ? <span className="live" aria-label="live">●</span> : null}</td>
                <td>{pct(p)}</td>
                <td className={side || ""}>{p == null || m.amm.yes == null ? "–" : ((p - m.amm.yes) * 100).toFixed(1) + " pts"}{side ? ` · ${side.toUpperCase()} cheap` : ""}</td>
                <td>{m.amm.trades}</td>
                <td><button type="button" onClick={(e) => { e.stopPropagation(); onSelect(m.market); }}>Trade</button></td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </section>
  )).concat(liveAt ? [<p key="live" className="muted small">● AMM YES read live from the Market accounts at {new Date(liveAt * 1000).toISOString().slice(11, 19)}Z (refreshes every 20 s).</p>] : []);
}

export function TradePanel({ market: m, now, cluster, dev = null, onTraded }) {
  const [side, setSide] = useState("yes");
  const [amount, setAmount] = useState("10");
  const [spot, setSpot] = useState("");
  const [acct, setAcct] = useState(null);
  const [tx, setTx] = useState(null);
  const sess = dev?.s;
  useEffect(() => { setSpot(""); setAcct(null); setTx(null); }, [m?.market]);
  // Live on-chain market account for the exact quote; refreshed every 20 s and after each trade.
  useEffect(() => {
    if (!m || !sess) return;
    let live = true;
    const load = () => sess.chain.fetchMarket(sess, m.market).then((a) => live && setAcct(a)).catch(() => {});
    load(); const t = setInterval(load, 20000);
    return () => { live = false; clearInterval(t); };
  }, [m?.market, sess, tx]);
  if (!m) return <aside className="trade"><h2>Trade</h2><p className="muted">Pick a market on the left.</p></aside>;
  const p = modelYes(m, now, Number(spot));
  const st = acct ? marketState(acct, nowSecs()) : null;
  const xq = st ? exactBuyQuote(st, { side, amountUsdc: Number(amount), pYes: p }) : null;
  const est = quotePreview({ side, amountUsdc: Number(amount), ammYes: st ? st.price : m.amm.yes, pYes: p });
  const hint = suggestedSide(p, st ? st.price : m.amm.yes);
  const blocker = buyBlocker({ hasWallet: !!sess?.owner, bal: dev?.bal, amountUsdc: Number(amount), quote: xq, busy: dev?.busy });
  const doBuy = () => dev.act(`Buying ${side.toUpperCase()}`, async () => {
    const fresh = await sess.chain.fetchMarket(sess, m.market); // re-quote against the latest pool right before signing
    const q = exactBuyQuote(marketState(fresh, nowSecs()), { side, amountUsdc: Number(amount), pYes: p });
    if (!q) throw new Error("market not tradable");
    const sig = await sess.chain.buy(sess, m.market, side, q.amountIn, q.minOutRaw);
    setTx(sig); await dev.refresh(); onTraded?.();
    return `Bought ≈${q.tokens.toFixed(2)} ${side.toUpperCase()} for ${Number(amount)} mUSDC · tx ${sig}`;
  });
  return (
    <aside className="trade">
      <h2>{m.name}</h2>
      <p className="muted">YES pays 1 mUSDC if the first Pyth print at/after expiry is above {money(m.strike, m.asset)}. Expires in {fmtLeft(m.endTs - now)}.</p>
      <div className="seg">
        {["yes", "no"].map((s) => <button key={s} type="button" className={side === s ? "on " + s : s} onClick={() => setSide(s)}>Buy {s.toUpperCase()}</button>)}
      </div>
      <label>Amount (mUSDC)<input aria-label="amount" type="number" min="0" step="1" value={amount} onChange={(e) => setAmount(e.target.value)} /></label>
      <label>Spot for the model <input aria-label="spot" type="number" placeholder={String(m.amm.spot ?? m.seed.spot ?? "")} value={spot} onChange={(e) => setSpot(e.target.value)} /></label>
      {xq ? (
        <dl>
          <dt>AMM price ({side.toUpperCase()}, live)</dt><dd>{pct(xq.price)} → {pct(xq.priceAfter)}</dd>
          <dt>Model P({side.toUpperCase()})</dt><dd>{p == null ? "–" : pct(side === "yes" ? p : 1 - p)}</dd>
          <dt>Avg price (incl. fee)</dt><dd>{pct(xq.avgPrice, 2)}</dd>
          <dt>Edge vs avg price</dt><dd className={xq.edgePts > 0 ? "yes" : "no"}>{xq.edgePts == null ? "–" : xq.edgePts.toFixed(1) + " pts"}</dd>
          <dt>Fee (2%)</dt><dd>{xq.fee.toFixed(3)}</dd>
          <dt>Tokens (exact)</dt><dd>{xq.tokens.toFixed(3)}</dd>
          <dt>Min received (1% slip)</dt><dd>{(xq.minOutRaw / 1e6).toFixed(3)}</dd>
          <dt>Max payout</dt><dd>{xq.maxPayout.toFixed(3)} mUSDC</dd>
          <dt>Model EV</dt><dd className={xq.ev > 0 ? "yes" : "no"}>{xq.ev == null ? "–" : `${xq.ev.toFixed(3)} (${pct(xq.evPct)})`}</dd>
        </dl>
      ) : (
        <dl>
          <dt>AMM price ({side.toUpperCase()})</dt><dd>{est ? pct(est.price) : "–"}</dd>
          <dt>Model P({side.toUpperCase()})</dt><dd>{p == null ? "–" : pct(side === "yes" ? p : 1 - p)}</dd>
          <dt>Edge</dt><dd className={est && est.edgePts > 0 ? "yes" : "no"}>{est?.edgePts == null ? "–" : est.edgePts.toFixed(1) + " pts"}</dd>
          <dt>Fee (2%)</dt><dd>{est ? est.fee.toFixed(3) : "–"}</dd>
          <dt>Tokens (≈, no slippage)</dt><dd>{est ? est.tokens.toFixed(3) : "–"}</dd>
          <dt>Max payout</dt><dd>{est ? est.maxPayout.toFixed(3) + " mUSDC" : "–"}</dd>
          <dt>Model EV</dt><dd className={est && est.ev > 0 ? "yes" : "no"}>{est?.ev == null ? "–" : `${est.ev.toFixed(3)} (${pct(est.evPct)})`}</dd>
        </dl>
      )}
      <p className="muted small">{xq ? "Exact pm-AMM curve quote from the live devnet pool (same math the program runs)." : "Marginal-price estimate from the keeper log; the exact quote loads from devnet."}</p>
      {hint && <p className="hint">Model says <b>{hint.toUpperCase()}</b> is cheap by more than fee + 3 pts.</p>}
      <button type="button" className={"cta buy " + side} disabled={!!blocker} title={blocker || ""} onClick={doBuy}>
        Sign &amp; buy {side.toUpperCase()} with burner (devnet)</button>
      {blocker && <p className="muted small">{blocker}</p>}
      {tx && <p className="small">Tx <a href={solscan(tx, cluster)} target="_blank" rel="noreferrer">{tx.slice(0, 10)}…</a></p>}
      {m.url ? <a className="alt" href={m.url} target="_blank" rel="noreferrer">Or trade this market on the pm-AMM devnet app ↗</a> : null}
      <p className="muted small">Devnet only, play money.
        {m.seed.createTx ? <> Created in <a href={solscan(m.seed.createTx, cluster)} target="_blank" rel="noreferrer">{m.seed.createTx.slice(0, 8)}…</a>.</> : null}</p>
    </aside>
  );
}

// Exit control for one open position: pick side + amount, exact sell quote from the live pool, signed yesToUsdc/noToUsdc
// with a 1% min-out bound (same gates as buy: devnet RPC only, re-quote right before signing).
export function SellControl({ row, dev, pYes = null }) {
  const sides = ["yes", "no"].filter((k) => row[k] > 0);
  const [side, setSide] = useState(sides[0] || "yes");
  const [amount, setAmount] = useState("");
  const [acct, setAcct] = useState(null);
  const sess = dev?.s;
  const held = row[side] || 0, heldRaw = row[side + "Raw"] || 0;
  useEffect(() => { if (!row[side]) setSide(sides[0] || "yes"); }, [row.yes, row.no]);
  useEffect(() => {
    if (!sess) return;
    let on = true;
    const load = () => sess.chain.fetchMarket(sess, row.market).then((a) => on && setAcct(a)).catch(() => {});
    load(); const t = setInterval(load, 20000);
    return () => { on = false; clearInterval(t); };
  }, [sess, row.market, row.yes, row.no]);
  const amt = amount === "" ? held : Number(amount);
  const raw = (a) => (Math.abs(a - held) < 1e-9 ? heldRaw : Math.floor(a * 1e6)); // "all" sells the exact raw balance
  const q = acct ? exactSellQuote(marketState(acct, nowSecs()), { side, tokensRaw: raw(amt), pYes }) : null;
  const blocker = sellBlocker({ hasWallet: !!sess?.owner, bal: dev?.bal, tokens: amt, held, quote: q, busy: dev?.busy });
  const doSell = () => dev.act(`Selling ${side.toUpperCase()}`, async () => {
    const fresh = await sess.chain.fetchMarket(sess, row.market);
    const fq = exactSellQuote(marketState(fresh, nowSecs()), { side, tokensRaw: raw(amt), pYes });
    if (!fq) throw new Error("market not tradable");
    const sig = await sess.chain.sell(sess, row.market, side, fq.amountIn, fq.minOutRaw);
    dev.setLastTx?.(sig); setAmount(""); await dev.refresh();
    return `Sold ${fq.tokens.toFixed(2)} ${side.toUpperCase()} for ≈${fq.usdc.toFixed(3)} mUSDC (min ${(fq.minOutRaw / 1e6).toFixed(3)}) · tx ${sig}`;
  });
  return (
    <div className="sellbox">
      {sides.length > 1 ? <select aria-label="sell side" value={side} onChange={(e) => setSide(e.target.value)}>{sides.map((k) => <option key={k} value={k}>{k.toUpperCase()}</option>)}</select> : <span>{side.toUpperCase()}</span>}
      <input aria-label="sell amount" type="number" min="0" step="0.01" placeholder={held.toFixed(2)} value={amount} onChange={(e) => setAmount(e.target.value)} />
      <span className="muted small quote">{q ? `→ ${q.usdc.toFixed(3)} mUSDC (min ${(q.minOutRaw / 1e6).toFixed(3)}, ${pct(q.price)}→${pct(q.priceAfter)}${q.sellEdge == null ? "" : `, vs hold ${q.sellEdge >= 0 ? "+" : ""}${q.sellEdge.toFixed(3)}`})` : "quote…"}</span>
      <button type="button" className="sell" disabled={!!blocker} title={blocker || "sign a devnet sell with a 1% min-out bound"} onClick={doSell}>Sell</button>
    </div>
  );
}

export function Positions({ dev, log, bump, open = [], now = nowSecs() }) {
  const [rows, setRows] = useState(null);
  const sess = dev?.s;
  useEffect(() => {
    if (!sess?.owner) return;
    const markets = [...(log.open || []), ...log.resolutions.slice(0, 60)];
    sess.chain.positions(sess, markets).then((held) => setRows(positionRows(held, log.resolutions))).catch(() => setRows([]));
  }, [sess, log, bump, dev?.busy]);
  if (!sess?.owner) return null;
  const openById = new Map(open.map((m) => [m.market, m]));
  return (
    <section className="positions">
      <h2>Your positions <span className="muted small">({sess.wallet === "burner" ? "burner" : sess.wallet}, devnet)</span></h2>
      {!rows ? <p className="muted">Loading…</p> : !rows.length ? <p className="muted">No YES/NO tokens yet. Buy from the trade panel.</p> : (
        <table>
          <thead><tr><th>Market</th><th>YES</th><th>NO</th><th>Status</th><th>Exit / claim</th></tr></thead>
          <tbody>{rows.map((r) => {
            const om = r.status === "open" ? openById.get(r.market) : null;
            return (
            <tr key={r.market} data-market={r.market}><td>{r.name}</td><td>{r.yes ? r.yes.toFixed(2) : ""}</td><td>{r.no ? r.no.toFixed(2) : ""}</td>
              <td className={r.status === "won" ? "yes" : r.status === "lost" ? "no" : ""}>{r.status}{r.winner ? ` (${r.winner.toUpperCase()})` : ""}{r.status === "open" && !om ? " (expired, awaiting resolution)" : ""}</td>
              <td>{r.claimable > 0 ? <button type="button" className="claim" disabled={dev.busy} onClick={() => dev.act("Claiming", async () => { const sig = await sess.chain.claim(sess, r.market); await dev.refresh(); return `Claimed ${r.claimable.toFixed(2)} mUSDC · tx ${sig}`; })}>Claim {r.claimable.toFixed(2)}</button>
                : om ? <SellControl row={r} dev={dev} pYes={modelYes(om, now)} /> : null}</td></tr>
            );
          })}</tbody>
        </table>
      )}
    </section>
  );
}

export function Calibration({ log, size = 220 }) {
  const pts = calibrationPoints(log.stats?.calibration, size);
  const pad = 24, end = size - pad;
  return (
    <section className="calib">
      <h2>Calibration</h2>
      <svg width={size} height={size} role="img" aria-label="calibration chart: seed fair YES vs realised YES rate">
        <rect x={pad} y={pad} width={end - pad} height={end - pad} fill="none" stroke="#2b3550" />
        <line x1={pad} y1={end} x2={end} y2={pad} stroke="#8b93a7" strokeDasharray="4 4" />
        {pts.map((p) => (
          <g key={p.fair}>
            <line x1={p.cx} x2={p.cx} y1={p.y1} y2={p.y2} stroke="#7cb7ff" />
            <circle cx={p.cx} cy={p.cy} r={p.r} fill="#7cb7ff" fillOpacity="0.6"><title>{`fair ${pct(p.fair)} → realised ${pct(p.rate)} (n=${p.n})`}</title></circle>
          </g>
        ))}
        <text x={pad} y={size - 6} fontSize="10" fill="#8b93a7">seed fair YES →</text>
        <text x={4} y={pad - 8} fontSize="10" fill="#8b93a7">realised YES rate</text>
      </svg>
      <p className="muted small">Dots: seed fair YES bucket vs realised YES rate (size ∝ √n, bars ±1.96 SE). Dashed = perfect calibration. {log.stats?.resolved} resolved.</p>
    </section>
  );
}

export function Resolved({ log }) {
  const rows = log.resolutions.slice(0, 10);
  return (
    <section>
      <h2>Recently resolved</h2>
      <table>
        <thead><tr><th>Market</th><th>Seed fair YES</th><th>Result</th><th>Settle print</th><th>Source</th><th>Resolve tx</th></tr></thead>
        <tbody>{rows.map((r) => (
          <tr key={r.market}><td>{r.name}</td><td>{pct(r.seed.fairYes)}</td><td className={r.side}>{r.side.toUpperCase()}</td>
            <td>{money(r.oracle.price, r.asset)} ({r.oracle.lagSecs >= 0 ? "+" : ""}{r.oracle.lagSecs}s)</td><td>{String(r.oracle.source).split(" ")[0]}</td>
            <td>{r.resolveTx ? <a href={solscan(r.resolveTx, log.cluster)} target="_blank" rel="noreferrer">{r.resolveTx.slice(0, 8)}…</a> : "–"}</td></tr>
        ))}</tbody>
      </table>
    </section>
  );
}

export default function App({ initialLog = null, initialNow = null }) {
  const [log, setLog] = useState(initialLog);
  const [err, setErr] = useState(null);
  const [asset, setAsset] = useState("ALL");
  const [selected, setSelected] = useState(null);
  const [now, setNow] = useState(initialNow ?? nowSecs());
  useEffect(() => {
    if (initialLog) return;
    fetch(LOG_URL, { cache: "no-store" }).then((r) => (r.ok ? r.json() : Promise.reject(new Error("HTTP " + r.status)))).then(setLog).catch((e) => setErr(String(e)));
  }, [initialLog]);
  useEffect(() => { if (initialNow != null) return; const t = setInterval(() => setNow(nowSecs()), 30000); return () => clearInterval(t); }, [initialNow]);
  const open = useMemo(() => (log?.open || []).filter((m) => m.endTs > now), [log, now]);
  const market = open.find((m) => m.market === selected) || null;
  const dev = useDevnet();
  const [bump, setBump] = useState(0);
  const live = useLivePrices(dev.s, open, bump);
  const openLive = useMemo(() => withLivePrices(open, live?.prices), [open, live]);
  const marketLive = openLive.find((m) => m.market === selected) || null;
  return (
    <main>
      <header>
        <h1>StrikeBook <span className="tag">devnet</span></h1>
        <p className="muted">Perps-priced strike markets on the pm-AMM, resolved from the on-chain Pyth print. <a href="../">Resolution log &amp; calibration</a> · <a href="https://github.com/LMH-Solutions/strikebook">GitHub</a></p>
      </header>
      {err && <p className="err">Could not load the market log ({err}).</p>}
      {!log && !err && <p className="muted">Loading markets…</p>}
      {log && (
        <>
          <Kpis log={log} />
          <div className="tabs">{["ALL", "SOL", "BTC"].map((a) => <button key={a} type="button" className={asset === a ? "on" : ""} onClick={() => setAsset(a)}>{a}</button>)}</div>
          <div className="grid">
            <div><h2>Open markets</h2><MarketsList open={openLive} asset={asset} now={now} selected={selected} onSelect={setSelected} liveAt={live?.at} /></div>
            <div className="side">
              <WalletPanel dev={dev} cluster={log.cluster} />
              <TradePanel market={marketLive || market} now={now} cluster={log.cluster} dev={dev} onTraded={() => setBump((b) => b + 1)} />
            </div>
          </div>
          <Positions dev={dev} log={log} bump={bump} open={open} now={now} />
          <div className="grid2"><Resolved log={log} /><Calibration log={log} /></div>
          <footer className="muted small">Log generated {new Date(log.generatedAt * 1000).toISOString()} · program <code>{log.program}</code> · rule: {log.rule}</footer>
        </>
      )}
    </main>
  );
}
