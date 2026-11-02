#!/usr/bin/env bash
# StrikeBook keeper scheduler (devnet only). Every 15 min, aligned to the quarter hour + 30 s so
# 6h-grid expiries get resolved from the on-chain Pyth print within the 90 s window:
#   npm run tick -- --max-rungs 2  ->  npm run trade (edge re-centering trader)  ->  npm run build
#   ->  commit data logs + docs/ if they changed  ->  pull --rebase  ->  push.
# Usage: nohup scripts/tick-loop.sh >/dev/null 2>&1 &   (logs to data/tick.log; single instance via flock)
set -u
cd "$(dirname "$0")/.."
LOG=data/tick.log
exec 9>data/tick.lock
flock -n 9 || { echo "$(date -Is) another tick-loop is running" >>"$LOG"; exit 0; }
PERIOD=${TICK_PERIOD:-900}; OFFSET=${TICK_OFFSET:-30}
FILES="docs data/resolution-log.json data/markets.jsonl data/resolutions.jsonl data/claims.jsonl data/trades.jsonl data/trader-claims.jsonl"
while true; do
  {
    echo "=== $(date -Is) tick"
    timeout 600 npm run -s tick -- --max-rungs "${MAX_RUNGS:-2}" 2>&1 | grep -E '"(resolved|claims|created|sol|usdc)"|skipped|Error|error' | head -40
    [ "${TRADE:-1}" = 1 ] && timeout 300 npm run -s trade 2>&1 | grep -E '^traded|"(trades|claims|sol|usdc|volumeUsdc|feesUsdc)"|Error|error' | head -20
    timeout 120 npm run -s build -- --refresh 2>&1 | tail -2
    # shellcheck disable=SC2086
    existing=$(for f in $FILES; do [ -e "$f" ] && echo "$f"; done)
    # shellcheck disable=SC2086
    if [ -n "$(git status --porcelain -- $existing)" ]; then
      git add -- $existing
      # commit ONLY the keeper's paths, even if someone has other changes staged
      git commit -qm "keeper: dashboard + logs refresh $(date -u +%Y-%m-%dT%H:%MZ)" -- $existing
      # the remote may have moved (code pushes); replay our refresh on top, keeping ours on generated-file conflicts
      if ! timeout 120 git pull -q --rebase --autostash -X theirs origin main >/dev/null 2>&1; then git rebase --abort 2>/dev/null; echo "pull --rebase failed"; fi
      if timeout 120 git push -q origin main >/dev/null 2>&1; then echo "pushed $(git rev-parse --short HEAD)"; else echo "PUSH FAILED $(git rev-parse --short HEAD)"; fi
    else
      echo "no data change"
    fi
  } >>"$LOG" 2>&1
  # keep log bounded
  [ "$(wc -l <"$LOG")" -gt 5000 ] && tail -n 2000 "$LOG" >"$LOG.tmp" && mv "$LOG.tmp" "$LOG"
  # sleep to the next slot by WALL CLOCK in short naps: the box VM can be paused, which stretches one long `sleep`
  next=$(( ($(date +%s) / PERIOD + 1) * PERIOD + OFFSET ))
  while [ "$(date +%s)" -lt "$next" ]; do sleep 20; done
done
