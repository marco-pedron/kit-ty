#!/usr/bin/env bash
# demo:unlock: unlock the 4 RLN nodes with the passwords saved by the seed.
set -euo pipefail
"$(dirname "$0")/node22.sh" unlock.ts
