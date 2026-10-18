#!/usr/bin/env bash
# EXPERIMENT demo:reset:1ch: wipe ONLY the kitty-1ch stack and infra/data/1ch, then seed one
# channel per traveler funded by an atomic swap. Never touches the demo stack `kitty`.
set -euo pipefail
source "$(dirname "$0")/env-1ch.sh"
source "$(dirname "$0")/lib.sh"
"$INFRA_DIR/scripts/node22.sh" no-fakes.ts
$COMPOSE down -v --remove-orphans
rm -rf "$INFRA_DIR/data/1ch"
mkdir -p "$INFRA_DIR/data/1ch/secrets"
"$INFRA_DIR/scripts/up-1ch.sh"
"$INFRA_DIR/scripts/node22.sh" seed-1ch.ts | awk '/^sendBegin params/{skip=1; next} skip&&/^}/{skip=0; next} !skip'
