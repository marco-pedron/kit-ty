#!/usr/bin/env bash
# Run a script of infra/treasury on Node 22 (wdk-wallet-rgb's rgb-lib binary needs it).
# Installs the treasury's own npm project on first use and refuses unexpected versions.
# Usage: ./infra/scripts/node22.sh <script.ts> [args...]
set -euo pipefail
source "$(dirname "$0")/lib.sh"
NODE22="${KITTY_NODE22_VERSION:-22.23.3}"
TREASURY="$INFRA_DIR/treasury"

command -v fnm >/dev/null || _die "fnm not found: install it and run \`fnm install $NODE22\`"
run22() { fnm exec --using="$NODE22" "$@"; }

if [ ! -d "$TREASURY/node_modules/@utexo/wdk-wallet-rgb" ]; then
    echo "installing infra/treasury dependencies on Node $NODE22"
    (cd "$TREASURY" && run22 npm ci --no-fund --no-audit >/dev/null)
fi
# exact versions only (CLAUDE.md): stop if anything else got installed
for dep in "@utexo/wdk-wallet-rgb@2.0.3" "@utexo/rgb-lib@0.3.0-beta.8" "@utexo/rgb-lib-darwin-arm64@0.3.0-beta.8"; do
    (cd "$TREASURY" && run22 npm ls --all "${dep%@*}" 2>/dev/null) | grep -q "$dep" \
        || _die "infra/treasury: expected $dep, found another version; stop and tell the PM"
done
script="$1"
shift
(cd "$TREASURY" && run22 node "$script" "$@")
