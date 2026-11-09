import { useEffect, useMemo, useState } from "react";
import { groupLadders, modelYes, quotePreview, suggestedSide, fmtLeft, pct, money } from "./model.js";

export const LOG_URL = import.meta.env?.VITE_LOG_URL || "../resolution-log.json";
const solscan = (sig, cl) => `https://solscan.io/tx/${sig}?cluster=${cl}`;
const nowSecs = () => Math.floor(Date.now() / 1000);

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

export function MarketsList({ open, asset, now, selected, onSelect }) {
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
              <tr key={m.market} className={selected === m.market ? "sel" : ""} onClick={() => onSelect(m.market)}>
                <td>{money(m.strike, m.asset)}</td>
                <td>{pct(m.amm.yes)}</td>
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
  ));
}

export function TradePanel({ market: m, now, cluster }) {
  const [side, setSide] = useState("yes");
  const [amount, setAmount] = useState("10");
  const [spot, setSpot] = useState("");
  useEffect(() => { setSpot(""); }, [m?.market]);
  if (!m) return <aside className="trade"><h2>Trade</h2><p className="muted">Pick a market on the left.</p></aside>;
  const p = modelYes(m, now, Number(spot));
  const q = quotePreview({ side, amountUsdc: Number(amount), ammYes: m.amm.yes, pYes: p });
  const hint = suggestedSide(p, m.amm.yes);
  return (
    <aside className="trade">
      <h2>{m.name}</h2>
      <p className="muted">YES pays 1 mUSDC if the first Pyth print at/after expiry is above {money(m.strike, m.asset)}. Expires in {fmtLeft(m.endTs - now)}.</p>
      <div className="seg">
        {["yes", "no"].map((s) => <button key={s} type="button" className={side === s ? "on " + s : s} onClick={() => setSide(s)}>Buy {s.toUpperCase()}</button>)}
      </div>
      <label>Amount (mUSDC)<input aria-label="amount" type="number" min="0" step="1" value={amount} onChange={(e) => setAmount(e.target.value)} /></label>
      <label>Spot for the model <input aria-label="spot" type="number" placeholder={String(m.amm.spot ?? m.seed.spot ?? "")} value={spot} onChange={(e) => setSpot(e.target.value)} /></label>
      <dl>
        <dt>AMM price ({side.toUpperCase()})</dt><dd>{q ? pct(q.price) : "–"}</dd>
        <dt>Model P({side.toUpperCase()})</dt><dd>{p == null ? "–" : pct(side === "yes" ? p : 1 - p)}</dd>
        <dt>Edge</dt><dd className={q && q.edgePts > 0 ? "yes" : "no"}>{q?.edgePts == null ? "–" : q.edgePts.toFixed(1) + " pts"}</dd>
        <dt>Fee (2%)</dt><dd>{q ? q.fee.toFixed(3) : "–"}</dd>
        <dt>Tokens (≈, no slippage)</dt><dd>{q ? q.tokens.toFixed(3) : "–"}</dd>
        <dt>Max payout</dt><dd>{q ? q.maxPayout.toFixed(3) + " mUSDC" : "–"}</dd>
        <dt>Model EV</dt><dd className={q && q.ev > 0 ? "yes" : "no"}>{q?.ev == null ? "–" : `${q.ev.toFixed(3)} (${pct(q.evPct)})`}</dd>
      </dl>
      {hint && <p className="hint">Model says <b>{hint.toUpperCase()}</b> is cheap by more than fee + 3 pts.</p>}
      {m.url ? <a className="cta" href={m.url} target="_blank" rel="noreferrer">Trade this market on pm-AMM devnet ↗</a> : null}
      <p className="muted small">Devnet only, play money. In-page burner-wallet signing is the next M3 step; until then the button opens the same market in the pm-AMM devnet app.
        {m.seed.createTx ? <> Created in <a href={solscan(m.seed.createTx, cluster)} target="_blank" rel="noreferrer">{m.seed.createTx.slice(0, 8)}…</a>.</> : null}</p>
    </aside>
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
            <div><h2>Open markets</h2><MarketsList open={open} asset={asset} now={now} selected={selected} onSelect={setSelected} /></div>
            <TradePanel market={market} now={now} cluster={log.cluster} />
          </div>
          <Resolved log={log} />
          <footer className="muted small">Log generated {new Date(log.generatedAt * 1000).toISOString()} · program <code>{log.program}</code> · rule: {log.rule}</footer>
        </>
      )}
    </main>
  );
}
