#!/usr/bin/env bash
# Reruns the whole experiment from scratch: one RGB channel per traveler funded by an atomic
# on-chain ↔ Lightning swap (stage 3). Touches only the compose project kitty-kaleido, its volumes
# and experiments/kaleidoswap/{run,.secrets,.out}. Never the demo stack `kitty`.
# Usage: experiments/kaleidoswap/run.sh
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
cd "$here"
mkdir -p .out

echo "== resources"
free=$(memory_pressure 2>/dev/null | awk -F': ' '/free percentage/{gsub("%","",$2); print $2}')
echo "host memory free: ${free:-?}%; load: $(uptime | sed 's/.*averages: //')"
if [ -n "${free:-}" ] && [ "$free" -lt 15 ]; then
    echo "less than 15% memory free: not starting a second stack next to the demo" >&2
    exit 1
fi
docker ps --format '{{.Names}}' | grep -q '^kitty-bitcoind-1$' && echo "demo stack kitty is running: left untouched"

echo "== images"
docker image inspect kitty/rln:kaleido-next >/dev/null 2>&1 || scripts/build-image.sh
docker image inspect kitty/htlc-tool:dev >/dev/null 2>&1 || docker build -t kitty/htlc-tool:dev htlc-tool
[ -d node_modules ] || npm ci --no-audit --no-fund

echo "== unit tests (dave's checks) and typecheck"
node --test src/swap-verify.test.ts 2>&1 | grep -E '^ℹ (tests|pass|fail)'
npx tsc -p .

echo "== fresh kitty-kaleido stack"
scripts/stack.sh reset >/dev/null 2>&1 || true
rm -rf run .secrets
scripts/stack.sh up full
for port in 23001 23002 23003 23004; do
    until curl -s "http://127.0.0.1:$port/nodeinfo" >/dev/null; do sleep 1; done
done

echo "== stage 3 e2e"
node src/stage3-e2e.ts 2>&1 | tee .out/stage3.log
