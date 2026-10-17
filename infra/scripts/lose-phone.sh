#!/usr/bin/env bash
# demo:lose-phone <member> (SPEC §12, P1): stop the member's node for good and restore a new one
# from the encrypted backup on the relay. Needs the relay and the agents running (pnpm dev).
set -euo pipefail
source "$(dirname "$0")/lib.sh"
"$INFRA_DIR/scripts/node22.sh" lose-phone.ts "${1:?usage: pnpm demo:lose-phone <alice|bob|charlie|dave>}"
