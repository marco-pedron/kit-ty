#!/usr/bin/env bash
# Wipe all regtest data (chain, indexes, RLN wallets) and start from a cold stack.
set -euo pipefail
source "$(dirname "$0")/lib.sh"
# the lose-phone profile too: a restored node and its volume go with the rest
$COMPOSE --profile lose-phone down -v --remove-orphans
rm -f "$INFRA_DIR"/.out/lost-*
"$(dirname "$0")/up.sh"
