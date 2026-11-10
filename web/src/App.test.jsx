import { describe, it, expect } from "vitest";
import { renderToString } from "react-dom/server";
import { createElement as h } from "react";
import fs from "node:fs";
import path from "node:path";
import App, { TradePanel, MarketsList, Calibration, WalletPanel } from "./App.jsx";

const log = JSON.parse(fs.readFileSync(path.resolve(__dirname, "../../data/resolution-log.json"), "utf8"));
const fixtureOpen = [{ market: "M1", marketId: 7, name: "SOL>90@2000", asset: "SOL", strike: 90, endTs: 2000,
  seed: { fairYes: 0.5, spot: 90, sigmaAnnual: 0.6, createTx: "abcdefghijk" }, amm: { yes: 0.4, trades: 2, spot: 91, sigmaAnnual: 0.6 }, url: "https://pm-amm-devnet.vercel.app/market/7" }];

describe("App (SSR smoke)", () => {
  it("renders KPIs, open markets and resolved table from the real keeper log", () => {
    const html = renderToString(h(App, { initialLog: { ...log, open: fixtureOpen }, initialNow: 1000 }));
    expect(html).toContain("StrikeBook");
    expect(html).toContain("Open markets");
    expect(html).toContain("Recently resolved");
    expect(html).toContain("$90");
    expect(html).toContain(log.resolutions[0].name.replace(">", "&gt;"));
  });
  it("trade panel shows quote and pm-AMM link", () => {
    const html = renderToString(h(TradePanel, { market: fixtureOpen[0], now: 1000, cluster: "devnet" }));
    expect(html.replace(/<!-- -->/g, "")).toContain("Buy YES");
    expect(html).toContain("pm-amm-devnet.vercel.app/market/7");
    expect(html).toContain("40.0%");
  });
  it("empty list message", () => {
    expect(renderToString(h(MarketsList, { open: [], asset: "ALL", now: 0, onSelect: () => {} }))).toContain("No open markets");
  });
  it("app shell has the burner wallet + calibration chart; trade button is gated without a wallet", () => {
    const html = renderToString(h(App, { initialLog: { ...log, open: fixtureOpen }, initialNow: 1000 })).replace(/<!-- -->/g, "");
    expect(html).toContain("DEVNET ONLY");
    expect(html).toContain("Create devnet burner wallet");
    expect(html).toContain("Calibration");
    const tp = renderToString(h(TradePanel, { market: fixtureOpen[0], now: 1000, cluster: "devnet" })).replace(/<!-- -->/g, "");
    expect(tp).toContain("Sign &amp; buy YES with burner (devnet)");
    expect(tp).toMatch(/<button[^>]*disabled=""[^>]*>Sign/);
    expect(tp).toContain("create the devnet burner wallet first");
  });
  it("calibration chart draws one dot per non-empty bin of the real log", () => {
    const html = renderToString(h(Calibration, { log }));
    expect((html.match(/<circle/g) || []).length).toBe(log.stats.calibration.filter((b) => b.n > 0).length);
  });
  it("wallet panel shows address/balances once a burner session exists", () => {
    const dev = { s: { kp: {}, address: "GDwVtusAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAXyZ1", rpc: "https://api.devnet.solana.com", chain: { exportKey: () => "[]" } }, bal: { sol: 0.2, usdc: 1000 }, msg: null, busy: false, open: () => {}, refresh: () => {}, act: () => {} };
    const html = renderToString(h(WalletPanel, { dev, cluster: "devnet" })).replace(/<!-- -->/g, "");
    expect(html).toContain("GDwV…XyZ1");
    expect(html).toContain("0.2000");
    expect(html).toContain("1000.00");
    expect(html).toContain("Faucet (mUSDC + SOL)");
  });
});
