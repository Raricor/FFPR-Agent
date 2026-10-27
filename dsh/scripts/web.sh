#!/usr/bin/env bash
# Restart the ffpr profile's dsh web app on :3081, detached from the calling shell, so a fresh
# `npm run build` is loaded (a replaced plugin module needs a restart). The startup URL with its
# token goes to ~/.dsh/logs/web-ffpr.log, where scripts/ask.mjs and the browser link read it.
set -euo pipefail

port=${FFPR_DSH_PORT:-3081}
log="$HOME/.dsh/logs/web-ffpr.log"
pattern="dsh --profile ffpr --no-open --port $port"

pkill -f -- "$pattern" || true
for _ in $(seq 1 20); do
    pgrep -f -- "$pattern" >/dev/null || break
    sleep 0.5
done

cd "$(dirname "$0")/../.."    # the FFPR-Agent checkout: the default workspace
setsid dsh --profile ffpr --no-open --port "$port" >"$log" 2>&1 </dev/null &

for _ in $(seq 1 60); do
    if grep -q "dsh web:" "$log" 2>/dev/null; then
        echo "ffpr web app is up on :$port (link with token in $log)"
        exit 0
    fi
    sleep 0.5
done
echo "ffpr web app did not start; see $log" >&2
exit 1
