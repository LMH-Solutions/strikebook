# StrikeBook

**Perps-priced strike markets on Solana, built on the Predict pm-AMM.**
Target: Solana Foundation *Perps and Prediction Markets* hackathon (main track) + PREDICT pm-AMM sponsor bounty.

"Will SOL be above $105 at 4 PM tomorrow?" StrikeBook lists ladders of short-dated binary strike markets on
the open pm-AMM program (`GV1FMGHRYBjQLaghE5fnGuYCuCcpdt3GD5xEX3TwN16y`). Every strike gets:

1. **Fair value**: a digital-option price from the live Pyth mark and realized vol. The pm-AMM's Gaussian-score
   model is a direct fit here, because the score is ln(S) − ln(K).
2. **Seeding**: a strike ladder at 10/25/50/75/90% so each market opens at a fair price (`initialPriceBps`).
3. **Oracle resolution**: a keeper resolves each market from the Pyth price at `endTs`. Today pm-AMM has no
   oracle and resolution is manual, so this fills a known gap.
4. **LP/perp-hedge view**: LP value and LVR from `@pm-amm/sdk/math`, plus the perp delta that hedges a YES/NO book.

## Run
```bash
npm install
npm test                       # 13 unit tests: pricing, ladder planner, resolver rule, quote math, devnet guard
npm run fair -- SOL 105 24     # live fair value: Pyth on-chain SOL/USD (mainnet, read-only) + Coinbase 1h realised vol
npm run markets                # read-only list of live devnet pm-AMM markets with current YES price
npm run serve                  # http://localhost:8787 dashboard: pricer, live StrikeBook ladder (fair vs pm-AMM edge), resolution log
npm run demo                   # END TO END on devnet in ~6 min: faucet -> fair-seeded ladder -> trade -> expiry -> Pyth resolve -> claim
npm run keeper -- status       # builder wallet, our markets, resolution count
npm run keeper -- ladder --asset BTC --mins 360 --deposit 25
npm run keeper -- resolve      # resolve every expired StrikeBook market from the oracle (authority-only)
npm run keeper -- claim        # pull winnings + LP residuals back after resolution
npm run keeper -- run --assets SOL,BTC --grid-hours 6   # long-running keeper: roll 6h ladders + auto-resolve
```
**Devnet only.** The keeper signs with a throwaway devnet keypair (`../.devnet-keys/builder.json`, outside the repo,
created on first run, funded by the pm-AMM faucet). Signing refuses any RPC URL containing "mainnet".

## How a market settles (published rule)
- Name `SOL>96.52@1793365356` = "Will SOL/USD be **strictly above** $96.52 at unix 1793365356?"
- Settlement price: the first Pyth `PriceUpdateV2` print with `publish_time >= expiry` read from the on-chain
  sponsored account (SOL `7UVimffx…`, BTC `4cSM2e6r…`), when the keeper is within 90 s of expiry. Later, it uses
  Pyth Hermes historical (needs `HERMES_API_KEY`), then the Coinbase 1-minute close as a labelled last resort (only after that candle has closed).
- Every resolution is appended to `data/resolutions.jsonl` with the oracle price, confidence, publish time, source
  and the devnet `resolveMarket` signature. Anyone can audit it.
- Seeding: each rung opens at `initialPriceBps = round(Φ(d2) × 10⁴)` from the same spot and vol, so the AMM starts at
  fair value and trades away from it only on flow. The dashboard shows the gap (edge) live.

## Layout
- `src/lib/pricing.cjs`: digital pricing, realized vol, strike ladder (uses `@pm-amm/sdk/math` Φ/Φ⁻¹)
- `src/lib/feeds.cjs`: Pyth PriceUpdateV2 decoder (on-chain, read-only), Hermes fallback, Coinbase candles
- `src/lib/resolver.cjs`: strike-name convention `SOL>150@<unix>`, settlement rule, oracle decision
- `src/lib/ladder.cjs`: ladder planner (target probabilities → rounded strikes → fair seed bps), 6h expiry grid
- `src/lib/pmamm.cjs`: devnet constants, clients, faucet, devnet guard, CJS port of the official exact-quote helpers
- `src/keeper.cjs`: create/resolve/claim/run keeper; `src/cli/demo.cjs`: end-to-end demo; `src/cli/trade.cjs`
- `data/markets.jsonl`, `data/resolutions.jsonl`: creation + resolution logs (devnet)
- `src/server.cjs`, `public/index.html`: local dashboard
- `src/cli/*`: CLIs

MIT License.
