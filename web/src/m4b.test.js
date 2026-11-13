import { describe, it, expect } from "vitest";
import { renderToString } from "react-dom/server";
import { createElement as h } from "react";
import { TryIt, HonestTraction, feedbackUrl } from "./App.jsx";

const t = { scannedAt: 1794580000, markets: { created: 10, resolved: 8, open: 2 },
  byGroup: { keeper: { trades: 0, volumeUsdc: 0, claims: 5, wallets: 1 }, traderBot: { trades: 7, volumeUsdc: 70, claims: 2, wallets: 1 }, teamTest: { trades: 1, volumeUsdc: 10, claims: 0, wallets: 1 } },
  ours: { trades: 8, volumeUsdc: 80, claims: 7, wallets: 3 }, outside: { trades: 2, volumeUsdc: 15, claims: 1, wallets: 1 } };

describe("M4 step 2: tester onboarding + honest traction", () => {
  it("TryIt walks through wallet, faucet, buy, sell, claim, feedback", () => {
    const html = renderToString(h(TryIt, { address: "Abc123" }));
    for (const s of ["60 seconds", "Create devnet burner wallet", "Faucet (mUSDC + SOL)", "faucet.solana.com", "Buy", "Sell", "Claim", "wallet=Abc123"]) expect(html).toContain(s);
    expect(html).toContain('id="try"');
  });
  it("feedback link targets the issue form", () => {
    expect(feedbackUrl(null)).toBe("https://github.com/LMH-Solutions/strikebook/issues/new?template=devnet-tester-feedback.yml&labels=tester-feedback");
  });
  it("HonestTraction splits ours vs outside", () => {
    const html = renderToString(h(HonestTraction, { t })).replace(/<!-- -->/g, "");
    expect(html).toContain("Outside wallets");
    expect(html).toContain("Trader bot (ours)");
    expect(html).toContain("team-wallets.json");
    expect(renderToString(h(HonestTraction, { t: null }))).toBe("");
  });
});
