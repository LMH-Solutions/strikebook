# Devnet E2E (headless Chrome, real Solana devnet, play money)

```bash
python3 -m http.server 8765 -d docs &            # from the repo root (serves docs/app + resolution-log.json)
cd web
node e2e/devnet-e2e.mjs --trade                  # burner: create, faucet, buy YES 10, sell half from Positions
node e2e/devnet-e2e.mjs --trade --both           # also buy NO on the same rung (one side is sure to win)
node e2e/devnet-e2e.mjs --trade --wallet=mock-phantom   # injected-wallet path, key held in Node
BURNER_KEY_FILE=burner.json node e2e/devnet-e2e.mjs https://lmh-solutions.github.io/strikebook/app/ --claim  # after resolution: preload the devnet burner, click every Claim
BURNER_KEY_FILE=burner.json node e2e/devnet-e2e.mjs --positions  # read-only positions report (open / won / lost)
node e2e/devnet-e2e.mjs https://lmh-solutions.github.io/strikebook/app/   # read-only smoke test of the live site
```
Prints a JSON report. Exit code 0 only if every tx finalized on devnet with `err: null`. Needs `/usr/bin/google-chrome` (or `CHROME=`).
