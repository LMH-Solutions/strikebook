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

## Run (dev skeleton)
```bash
npm install
npm test                       # pricing / decoder / name-parser unit tests
npm run fair -- SOL 105 24     # live fair value: Pyth on-chain SOL/USD (mainnet, read-only) + Coinbase 1h realised vol
npm run serve                  # http://localhost:8787 local dashboard + /api/fair, /api/resolve
npm run markets                # read-only list of devnet pm-AMM markets (needs a reachable devnet RPC: RPC_URL=...)
```
No wallet, no signing, no funds. Devnet signing (create/resolve markets) will come in milestone M2, using a
throwaway devnet keypair.

## Layout
- `src/lib/pricing.cjs`: digital pricing, realized vol, strike ladder (uses `@pm-amm/sdk/math` Φ/Φ⁻¹)
- `src/lib/feeds.cjs`: Pyth PriceUpdateV2 decoder (on-chain, read-only), Hermes fallback, Coinbase candles
- `src/lib/resolver.cjs`: strike-name convention `SOL>150@<unix>` and dry-run YES/NO decision
- `src/server.cjs`, `public/index.html`: local dashboard
- `src/cli/*`: CLIs

MIT License.
