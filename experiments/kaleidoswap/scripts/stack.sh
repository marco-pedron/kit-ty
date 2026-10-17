#!/usr/bin/env bash
# Experiment stack `kitty-kaleido` (never the demo project `kitty`).
# Usage: stack.sh up [full] | down | reset | ps
set -euo pipefail
here="$(cd "$(dirname "$0")/.." && pwd)"
PROJECT=kitty-kaleido
COMPOSE=(docker compose -p "$PROJECT" -f "$here/compose.yaml")
PORTS=(28443 23501 23010 23000 23001 23002 23003 23004)

case "${1:-}" in
up)
    docker image inspect kitty/rln:kaleido-next >/dev/null 2>&1 \
        || { echo "image kitty/rln:kaleido-next missing: run scripts/build-image.sh" >&2; exit 1; }
    if [ -z "$("${COMPOSE[@]}" ps -q 2>/dev/null)" ]; then
        for p in "${PORTS[@]}"; do
            if lsof -nP -iTCP:"$p" -sTCP:LISTEN -t >/dev/null 2>&1; then
                echo "port $p already in use" >&2; exit 1
            fi
        done
    fi
    profile=()
    [ "${2:-}" = full ] && profile=(--profile full)
    "${COMPOSE[@]}" ${profile[@]+"${profile[@]}"} up -d
    ;;
down) "${COMPOSE[@]}" --profile full stop ;;
reset)
    # removes only this project's containers and volumes
    "${COMPOSE[@]}" --profile full down -v --remove-orphans
    ;;
ps) "${COMPOSE[@]}" --profile full ps ;;
*) echo "usage: $0 up [full] | down | reset | ps" >&2; exit 1 ;;
esac
