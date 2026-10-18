# EXPERIMENT: the environment of KITTY_RAIL_MODE=ln-1ch-swap (one channel per traveler + atomic
# swap). Source it, don't run it. Every port differs from the demo stack `kitty`, so both run
# side by side; every file lives under infra/data/1ch (gitignored).
_REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
_D1="$_REPO/infra/data/1ch"
export KITTY_STACK=1ch
export KITTY_RAIL_MODE=ln-1ch-swap
export KITTY_RLN_FLAVOR=kaleido
export KITTY_COMPOSE_FILE="$_REPO/infra/docker-compose.1ch.yml"
export RLN_ALICE_URL=http://127.0.0.1:33001
export RLN_BOB_URL=http://127.0.0.1:33002
export RLN_CHARLIE_URL=http://127.0.0.1:33003
export RLN_DAVE_URL=http://127.0.0.1:33004
export ESPLORA_URL=http://127.0.0.1:33010
export RGB_PROXY_URL_HOST=rpc://127.0.0.1:33000/json-rpc
export ELECTRS_URL_HOST=tcp://127.0.0.1:33501
export KITTY_SECRETS_FILE="$_D1/secrets/nodes.json"
export KITTY_SEED_STATE_FILE="$_D1/seed-state.json"
export KITTY_BACKUP_DIR="$_D1/backups"
export TREASURY_DATA_DIR="$_D1/treasury"
# experiments/kaleidoswap helpers (swap, htlc-tool) on this stack
export KK_RUN_DIR="$_D1/run"
export KK_ALICE_URL=$RLN_ALICE_URL KK_BOB_URL=$RLN_BOB_URL KK_CHARLIE_URL=$RLN_CHARLIE_URL KK_DAVE_URL=$RLN_DAVE_URL
export KK_BITCOIND_URL=http://127.0.0.1:38443
export KK_ELECTRS_PORT=33501
export KK_NETWORK=kitty-1ch_default
# apps
export RELAY_PORT=4001
export RELAY_URL=http://127.0.0.1:4001
export RELAY_DB="$_D1/relay.sqlite"
export AGENT_PORT=4101
export WEB_PORT=5174
export E2E_RELAY_PORT=4401
export E2E_AGENT_PORT=4501
