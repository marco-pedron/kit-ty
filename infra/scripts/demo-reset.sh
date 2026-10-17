#!/usr/bin/env bash
# demo:reset: refuse fakes, wipe the stack (volumes, treasury data), seed from scratch.
# Wiping first is what makes two runs in a row safe.
set -euo pipefail
source "$(dirname "$0")/lib.sh"
"$INFRA_DIR/scripts/node22.sh" no-fakes.ts
# backups of the previous nodes: restoring one now would be an old channel state (SPEC §12)
rm -rf "$INFRA_DIR/data/backups"
"$INFRA_DIR/scripts/reset.sh"
rm -rf "${TREASURY_DATA_DIR:-$INFRA_DIR/data/treasury}"
# the relay of `pnpm dev` holds the previous trip: the agents would refuse it (StaleRelayError)
rm -f "$INFRA_DIR/../apps/relay/data/relay.sqlite"*
# the seed prints rgb-lib's debug output ("sendBegin params"); hide it, keep everything else
"$INFRA_DIR/scripts/node22.sh" seed.ts | awk '/^sendBegin params/{skip=1; next} skip&&/^}/{skip=0; next} !skip'
