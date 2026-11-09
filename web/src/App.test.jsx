import { describe, it, expect } from "vitest";
import { renderToString } from "react-dom/server";
import { createElement as h } from "react";
import fs from "node:fs";
import path from "node:path";
import App, { TradePanel, MarketsList } from "./App.jsx";

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
});
