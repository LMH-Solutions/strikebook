# StrikeBook

**Perps-priced strike markets on Solana, built on the Predict pm-AMM.**
Target: Solana Foundation *Perps and Prediction Markets* hackathon (main track) + PREDICT pm-AMM sponsor bounty.

**Live dashboard (devnet):** https://lmh-solutions.github.io/strikebook/ (rebuilt by the keeper; raw data:
[`resolution-log.json`](https://lmh-solutions.github.io/strikebook/resolution-log.json))

## Devnet demo at a glance
- A keeper (`npm run tick`, every 15 min) lists **ladders of short-dated SOL and BTC strike markets** on the pm-AMM devnet program,
  each seeded at its fair digital-option price, then **resolves them from the on-chain Pyth print** at expiry and claims back.
- So far: 10+ markets across 5+ ladders resolved, with 9 settled on the on-chain Pyth print (seconds after expiry). The fair-value seeds score
  **Brier 0.236 vs 0.25** for a coin flip (the dashboard shows the current figure and calibration buckets).
- An **edge re-centering trader** (`npm run trade`, same 15-min loop) prices every open rung from the live Pyth spot + realised vol
  and buys the cheap side whenever the pm-AMM price is more than fee + 3 pts off the model, producing real pm-AMM volume and fees.
  Trades, volume and fees are on the dashboard ("Traction") and in `data/trades.jsonl`.
- Every market, oracle print (price, confidence, publish_time, lag) and devnet transaction is logged in `data/` and
  linked from the dashboard so anyone can audit the settlement.
- Example market on the pm-AMM UI: https://pm-amm-devnet.vercel.app/market/33688544903757
- Devnet test tokens only. No real money, no mainnet signing (the signer refuses any `mainnet` RPC URL).

## Quick start
```bash
git clone https://github.com/LMH-Solutions/strikebook && cd strikebook
npm install
npm test              # 23 unit tests, no network needed
npm run tick -- --dry # read-only: what the keeper would do right now
npm run build         # regenerate docs/ (static dashboard)
```

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
npm test                       # unit tests: pricing, ladder planner, resolver rule, quote math, devnet guard, roller, resolution log, site
npm run fair -- SOL 105 24     # live fair value: Pyth on-chain SOL/USD (mainnet, read-only) + Coinbase 1h realised vol
npm run markets                # read-only list of live devnet pm-AMM markets with current YES price
npm run serve                  # http://localhost:8787 dashboard: pricer, live StrikeBook ladder (fair vs pm-AMM edge), resolution log
npm run demo                   # END TO END on devnet in ~6 min: faucet -> fair-seeded ladder -> trade -> expiry -> Pyth resolve -> claim
npm run keeper -- status       # builder wallet, our markets, resolution count
npm run keeper -- ladder --asset BTC --mins 360 --deposit 25
npm run keeper -- resolve      # resolve every expired StrikeBook market from the oracle (authority-only)
npm run keeper -- claim        # pull winnings + LP residuals back after resolution
npm run tick -- --dry          # M2 keeper pass, read-only: shows what it would resolve / create under the current SOL budget
npm run tick                   # one idempotent pass: resolve due -> claim -> faucet (<=1/h) if short -> roll SOL+BTC ladders -> rebuild log
npm run keeper -- run --poll 60   # same pass in a loop (needs an always-on host); flags: --assets --grid-hours --lead-mins --max-rungs --deposit
npm run trade -- --dry         # M2 edge trader, read-only: model P(YES) vs pm-AMM price per open rung, planned trades
npm run trade                  # one pass: claim winnings on resolved traded markets -> faucet trader wallet if short -> re-centre open rungs
npm run swap -- <market> usdcToYes 5   # one manual devnet swap with an exact quote + 1% slippage bound
npm run keeper -- log          # rebuild data/resolution-log.json from the jsonl logs
npm run build                  # static dashboard -> docs/ (index.html + resolution-log.json), no JS/keys/server, GitHub-Pages ready
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

## Keeper on scarce devnet SOL (M2)
pm-AMM has no close-market instruction, so each market's ~0.035 SOL rent is gone for good and the faucet gives 0.2 SOL/h.
The roller (`src/lib/roller.cjs`) therefore keeps **one live ladder per asset**, rolls it only once it has expired, and sizes
it to the wallet: rungs are allocated round-robin across SOL/BTC, ATM (50%) first, then 25/75, then 10/90 (default max 3).
If it can't afford the full ladder it asks the hourly faucet, and if it can't afford even one rung it skips with
`low-balance`. Each `tick` is idempotent, so a cron job / scheduled routine every 15–60 min is enough (no always-on host).
The RPC is the first healthy keyless devnet endpoint (`pickRpc`), or `RPC_URL`.

## Edge re-centering trader (M2)
`src/trader.cjs` runs from its **own throwaway devnet wallet** (`../.devnet-keys/trader.json`, created on first run, funded by the
hourly pm-AMM faucet), separate from the keeper/LP wallet, so it pays the real 2% swap fee (half to the market creator, half to the protocol).
For every open rung it computes `P(YES) = Φ(d2)`, `d2 = [ln(S/K) − σ²τ/2] / (σ√τ)` from the on-chain Pyth spot and 7-day hourly realised vol,
and `src/lib/trader.cjs` (pure, unit-tested) decides:
- no trade if `|model − AMM| < 2% fee + 3 pts` (`--min-edge`), or under 5 min to expiry;
- otherwise buy the cheap side (USDC→YES or USDC→NO), sized by inverting the pm-AMM curve so the price lands **fee + 0.5 pt short of the model**
  (never past it), capped at 20 mUSDC per trade (`--max-trade`), 60 mUSDC inventory per market (`--max-market`) and the wallet budget;
- only if the exact-quote expected value at the model probability is positive; the swap carries a 1% slippage bound.
After resolution it claims winnings (closing token accounts refunds their rent). SOL cost is ~0.003 SOL of token-account rent per new market traded.

## Layout
- `src/lib/pricing.cjs`: digital pricing, realized vol, strike ladder (uses `@pm-amm/sdk/math` Φ/Φ⁻¹)
- `src/lib/feeds.cjs`: Pyth PriceUpdateV2 decoder (on-chain, read-only), Hermes fallback, Coinbase candles
- `src/lib/resolver.cjs`: strike-name convention `SOL>150@<unix>`, settlement rule, oracle decision
- `src/lib/ladder.cjs`: ladder planner (target probabilities → rounded strikes → fair seed bps), 6h expiry grid
- `src/lib/pmamm.cjs`: devnet constants, clients, faucet, devnet guard, CJS port of the official exact-quote helpers
- `src/keeper.cjs`: create/resolve/claim/run keeper; `src/cli/demo.cjs`: end-to-end demo; `src/cli/trade.cjs`
- `data/markets.jsonl`, `data/resolutions.jsonl`: creation + resolution logs (devnet)
- `src/lib/roller.cjs`: pure tick planner (due markets, roll decisions, SOL/mUSDC budget, faucet need)
- `src/lib/reslog.cjs`, `data/resolution-log.json`: joined seed + oracle-proof log with Brier/calibration stats (committed)
- `src/lib/site.cjs`, `scripts/build-site.cjs`, `docs/`: static dashboard build
- `src/server.cjs`, `public/index.html`: local dashboard
- `src/lib/trader.cjs`, `src/trader.cjs`, `data/trades.jsonl`: edge re-centering trader (pure decision + I/O pass) and its trade log
- `src/cli/*`: CLIs

MIT License, see `LICENSE`.
