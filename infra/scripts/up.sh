#!/usr/bin/env bash
# Start the regtest stack (cold or warm) and wait until every service answers.
set -euo pipefail
source "$(dirname "$0")/lib.sh"

docker image inspect settleup/rln:d4762ac >/dev/null 2>&1 \
    || _die "image settleup/rln:d4762ac missing, run ./infra/scripts/build-rln.sh first (same tag as the old project, never another version)"

# Port pre-check, skipped when our stack is already running (it owns the ports).
if [ -z "$($COMPOSE ps -q 2>/dev/null)" ]; then
    for port in 3000 3001 3002 3003 3004 3010 18443 50001 9735 9736 9737 9738 "${NOSTR_PORTS[@]}"; do
        if lsof -nP -iTCP:"$port" -sTCP:LISTEN -t >/dev/null 2>&1; then
            _die "port $port is already in use: $(lsof -nP -iTCP:"$port" -sTCP:LISTEN | tail -1)"
        fi
    done
fi

# bitcoind first, so electrs and esplora don't fail on an unavailable RPC
# demo:lose-phone stopped a node for good: starting it again would bring an old channel state
# back online (SPEC §12). Only demo:reset clears it.
for lost in "$INFRA_DIR"/.out/lost-*; do
    if [ -e "$lost" ]; then
        _die "$(basename "$lost" | sed 's/lost-//') lost their phone: run pnpm demo:reset, not infra:up"
    fi
done
# B6: one backup folder per node, bind-mounted at /backups (gitignored, like all of infra/data)
for m in alice bob charlie dave; do mkdir -p "$INFRA_DIR/data/backups/$m"; done
$COMPOSE up -d bitcoind
echo "waiting for bitcoind RPC"
_wait_until "bitcoind RPC" $BITCOIN_CLI getblockchaininfo || { $COMPOSE logs bitcoind; exit 1; }

if ! $BITCOIN_CLI -rpcwallet=miner getwalletinfo >/dev/null 2>&1; then
    $BITCOIN_CLI loadwallet miner >/dev/null 2>&1 || $BITCOIN_CLI createwallet miner >/dev/null
fi
height=$($BITCOIN_CLI getblockcount)
if [ "$height" -lt 103 ]; then
    echo "mining $((103 - height)) initial blocks"
    $BITCOIN_CLI -rpcwallet=miner -generate $((103 - height)) >/dev/null
fi

$COMPOSE up -d
echo "waiting for electrs (port 50001)"
_wait_until "electrs" nc -z 127.0.0.1 50001 || { $COMPOSE logs electrs; exit 1; }
echo "waiting for esplora REST ($ESPLORA_URL)"
_wait_until "esplora" curl -sf "$ESPLORA_URL/blocks/tip/height" || { $COMPOSE logs esplora; exit 1; }
for port in "${RLN_PORTS[@]}"; do
    echo "waiting for RLN on $port"
    # any HTTP status counts: a fresh node answers /nodeinfo with an error until init+unlock
    _wait_until "RLN $port" curl -s -o /dev/null "http://127.0.0.1:$port/nodeinfo" \
        || { $COMPOSE logs; exit 1; }
done
for port in "${NOSTR_PORTS[@]}"; do
    echo "waiting for the Nostr relay on $port"
    _wait_until "nostr $port" nc -z 127.0.0.1 "$port" || { $COMPOSE logs; exit 1; }
done
echo "stack up: bitcoind height $($BITCOIN_CLI getblockcount), esplora $ESPLORA_URL, RLN ${RLN_PORTS[*]}, Nostr ${NOSTR_PORTS[*]}"
