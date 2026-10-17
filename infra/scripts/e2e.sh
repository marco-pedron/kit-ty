#!/usr/bin/env bash
# pnpm e2e:<name>: run apps/agent/src/e2e/<name>.e2e.ts on the regtest stack, IRREVERSIBLE
# (run `pnpm demo:reset` first). The output goes to the terminal and to
# infra/.out/logs/<date-time>-e2e-<name>.log, with the relay and agent output next to it.
set -euo pipefail
source "$(dirname "$0")/lib.sh"
name="${1:?usage: e2e.sh <scenario>}"
"$INFRA_DIR/scripts/node22.sh" no-fakes.ts
logs="$INFRA_DIR/.out/logs"
mkdir -p "$logs"
stamp="$(date +%Y%m%d-%H%M%S)"
log="$logs/$stamp-e2e-$name.log"
export KITTY_E2E_LOG="$logs/$stamp-e2e-$name-processes.log"
cd "$INFRA_DIR/.."
set +e
pnpm exec vitest run -c apps/agent/src/e2e/vitest.e2e.config.ts "$name.e2e" 2>&1 | tee "$log"
status=${PIPESTATUS[0]}
set -e
echo "log: $log (processes: $KITTY_E2E_LOG)"
exit "$status"
