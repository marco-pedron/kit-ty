#!/usr/bin/env bash
# EXPERIMENT: start the kitty-1ch stack (fork image) next to the demo stack and wait for it.
set -euo pipefail
source "$(dirname "$0")/env-1ch.sh"
source "$(dirname "$0")/lib.sh"
for img in kitty/rln:kaleido-next kitty/htlc-tool:dev; do
    docker image inspect "$img" >/dev/null 2>&1 \
        || _die "image $img missing: build it with experiments/kaleidoswap/run.sh (scripts/build-image.sh)"
done
if [ -z "$($COMPOSE ps -q 2>/dev/null)" ]; then
    for port in 33000 33001 33002 33003 33004 33010 38443 33501 39735 39736 39737 39738; do
        if lsof -nP -iTCP:"$port" -sTCP:LISTEN -t >/dev/null 2>&1; then
            _die "port $port is already in use"
        fi
    done
fi
for m in alice bob charlie dave; do mkdir -p "$INFRA_DIR/data/1ch/backups/$m"; done
$COMPOSE up -d bitcoind
_wait_until "bitcoind RPC" $BITCOIN_CLI getblockchaininfo || { $COMPOSE logs bitcoind; exit 1; }
if ! $BITCOIN_CLI -rpcwallet=miner getwalletinfo >/dev/null 2>&1; then
    $BITCOIN_CLI loadwallet miner >/dev/null 2>&1 || $BITCOIN_CLI createwallet miner >/dev/null
fi
height=$($BITCOIN_CLI getblockcount)
[ "$height" -ge 103 ] || $BITCOIN_CLI -rpcwallet=miner -generate $((103 - height)) >/dev/null
$COMPOSE up -d
_wait_until "electrs" nc -z 127.0.0.1 33501 || { $COMPOSE logs electrs; exit 1; }
_wait_until "esplora" curl -sf "$ESPLORA_URL/blocks/tip/height" || { $COMPOSE logs esplora; exit 1; }
for port in 33001 33002 33003 33004; do
    _wait_until "RLN $port" curl -s -o /dev/null "http://127.0.0.1:$port/nodeinfo" || { $COMPOSE logs; exit 1; }
done
echo "kitty-1ch up: bitcoind height $($BITCOIN_CLI getblockcount), esplora $ESPLORA_URL, RLN 33001-33004"
