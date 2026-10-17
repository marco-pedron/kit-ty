#!/usr/bin/env bash
# demo:reset: refuse fakes, wipe the stack (volumes, treasury data), seed from scratch.
# Wiping first is what makes two runs in a row safe.
set -euo pipefail
source "$(dirname "$0")/lib.sh"
"$INFRA_DIR/scripts/node22.sh" no-fakes.ts
"$INFRA_DIR/scripts/reset.sh"
rm -rf "${TREASURY_DATA_DIR:-$INFRA_DIR/data/treasury}"
# the seed prints rgb-lib's debug output ("sendBegin params"); hide it, keep everything else
"$INFRA_DIR/scripts/node22.sh" seed.ts | awk '/^sendBegin params/{skip=1; next} skip&&/^}/{skip=0; next} !skip'
