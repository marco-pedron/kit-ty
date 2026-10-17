#!/usr/bin/env bash
# Builds kitty/rln:kaleido-next from a clone of kaleidoswap/rgb-lightning-node at the pinned
# commit (with the rust-lightning submodule). Never touches the demo image settleup/rln:d4762ac.
# Usage: experiments/kaleidoswap/scripts/build-image.sh [path-to-fork-clone]
set -euo pipefail
here="$(cd "$(dirname "$0")/.." && pwd)"
fork="${1:-$here/../../../kaleidoswap/rln}"
commit=1e4b1c3905ace8833ceebbdf06fb69f79aac340d
[ "$(git -C "$fork" rev-parse HEAD)" = "$commit" ] || { echo "fork not at $commit" >&2; exit 1; }
[ -f "$fork/rust-lightning/Cargo.toml" ] || { echo "rust-lightning submodule missing" >&2; exit 1; }
docker build -f "$here/docker/rln-kaleido.Dockerfile" --build-arg CARGO_BUILD_JOBS="${CARGO_BUILD_JOBS:-2}" \
  -t kitty/rln:kaleido-next "$fork"
