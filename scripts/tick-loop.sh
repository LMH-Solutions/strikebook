#!/usr/bin/env bash
# StrikeBook keeper scheduler (devnet only). Every 15 min, aligned to the quarter hour + 30 s so
# 6h-grid expiries get resolved from the on-chain Pyth print within the 90 s window:
#   npm run tick -- --max-rungs 2  ->  npm run build  ->  commit + push data/ and docs/ if they changed.
# Usage: nohup scripts/tick-loop.sh >/dev/null 2>&1 &   (logs to data/tick.log; single instance via flock)
set -u
cd "$(dirname "$0")/.."
LOG=data/tick.log
exec 9>data/tick.lock
flock -n 9 || { echo "$(date -Is) another tick-loop is running" >>"$LOG"; exit 0; }
PERIOD=${TICK_PERIOD:-900}; OFFSET=${TICK_OFFSET:-30}
while true; do
  {
    echo "=== $(date -Is) tick"
    timeout 600 npm run -s tick -- --max-rungs "${MAX_RUNGS:-2}" 2>&1 | grep -E '"(resolved|claims|created|sol|usdc)"|skipped|Error|error' | head -40
    timeout 120 npm run -s build 2>&1 | tail -2
    if [ -n "$(git status --porcelain -- docs data/resolution-log.json data/markets.jsonl data/resolutions.jsonl data/claims.jsonl)" ]; then
      git add docs data/resolution-log.json data/markets.jsonl data/resolutions.jsonl data/claims.jsonl
      git commit -qm "keeper: dashboard + logs refresh $(date -u +%Y-%m-%dT%H:%MZ)" && timeout 120 git push -q origin main 2>&1 | tail -3
      echo "pushed $(git rev-parse --short HEAD)"
    else
      echo "no data change"
    fi
  } >>"$LOG" 2>&1
  # keep log bounded
  [ "$(wc -l <"$LOG")" -gt 5000 ] && tail -n 2000 "$LOG" >"$LOG.tmp" && mv "$LOG.tmp" "$LOG"
  now=$(date +%s); next=$(( (now / PERIOD + 1) * PERIOD + OFFSET )); sleep $(( next - now ))
done
