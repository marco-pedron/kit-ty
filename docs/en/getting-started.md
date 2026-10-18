# Getting started

This page gets kit+ty running on your machine. It is for anyone who wants to see the app: first
the two-minute path with simulated wallets and AI (`pnpm dev:fakes`), which needs only Node and
pnpm; then the real path on a Bitcoin regtest stack with four RGB Lightning nodes, which needs
Docker and a few one-time steps. Everything runs locally and on regtest only.

## Prerequisites

| Tool                                                               | Version                                                                                                       | Needed for                                              |
| ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| Node.js                                                            | `22.x`, `>=22.17 <23` (`package.json` `engines`); the repo pins `22.23.3` in `.node-version`                  | everything                                              |
| pnpm                                                               | `12.11.2` (`packageManager` in `package.json`; `corepack enable` picks it up)                                 | everything                                              |
| Docker (with Compose)                                              | any recent Docker Desktop; the stack uses about 0.5 GB of RAM after the seed                                  | real stack only                                         |
| [fnm](https://github.com/Schniz/fnm) with Node `22.23.3` installed | the seed runs `@utexo/wdk-wallet-rgb` through `fnm exec` (`infra/scripts/node22.sh`)                          | real stack only                                         |
| macOS on Apple silicon                                             | the treasury project pins the `@utexo/rgb-lib-darwin-arm64` binary, and `ai:eval:offline` uses `sandbox-exec` | real stack and the offline AI eval                      |
| QVAC model files in the local cache                                | `QVAC_CACHE_DIR`, default `~/.qvac/models`                                                                    | real AI only (see [AI pipeline](ai-pipeline.md#models)) |

## Quickstart: simulated mode (`pnpm dev:fakes`)

`KITTY_FAKES=1` replaces the Lightning wallets and the AI with in-memory fakes, so you can click
through every screen without Docker. **Nothing in this mode is a real RGB transaction**, the
agent logs `FAKES ON: simulated wallet and AI, no real RGB transactions`, and the UI shows a
banner. The fake AI always returns the demo dinner receipt, whatever image you give it.

```sh
pnpm install
rm -f apps/relay/data/relay.sqlite*   # start from an empty relay database, every time
pnpm dev:fakes                        # relay :4000 + agents :4100 + web :5173
```

Then open one browser window per person, phone-sized:

```text
http://127.0.0.1:5173/?as=alice
http://127.0.0.1:5173/?as=bob
http://127.0.0.1:5173/?as=charlie
http://127.0.0.1:5173/?as=dave        # the operator's app
```

`?as=styleguide` shows the UI primitives.

> **Always start `pnpm dev:fakes` from an empty relay database.** The fake wallet keeps its
> invoices in the agent's memory. After a restart, the agents cannot verify the events a previous
> run left in `apps/relay/data/relay.sqlite`, so they reject the log from the first
> `MEMBER_JOINED`. The app then shows no members, an empty QR code, "not a member of the trip"
> errors and the red banner "The relay sent an entry this phone rejects". Stop the stack, run the
> `rm` above, start again.

## The real stack (regtest)

The real path runs four `rgb-lightning-node` (RLN) nodes in Docker, one per person, plus
`bitcoind`, `electrs`, an Esplora REST API and the RGB proxy. Every published port is bound to
`127.0.0.1` (`infra/docker-compose.yml`).

### 1. Build the RLN image (once)

```sh
./infra/scripts/build-rln.sh          # builds settleup/rln:d4762ac from the pinned commit
```

It clones `RGB-Tools/rgb-lightning-node` at commit `d4762ac3d1b3ca83f2f7b4f894e8569109dc572a`
into `infra/vendor/` and builds it. A cold build takes 15 to 40 minutes (`CARGO_BUILD_JOBS`,
default 2). `pnpm infra:up` refuses to start without this image.

### 2. Start the stack and seed it

```sh
pnpm infra:up       # bitcoind (mines 103 blocks), electrs, esplora, proxy, 4 RLN nodes
pnpm infra:check    # optional: 7 acceptance checks, ends with "all checks passed"
pnpm demo:reset     # wipe everything and seed the demo from scratch (about 80 s)
```

`pnpm demo:reset` does, in order (`infra/scripts/demo-reset.sh`):

1. refuses to run if `KITTY_FAKES=1` (`infra/treasury/no-fakes.ts`);
2. deletes old node backups, wipes the Docker volumes and restarts the stack (`infra:reset`);
3. deletes the treasury wallet data and the relay database `apps/relay/data/relay.sqlite`;
4. runs the seed (`infra/treasury/seed.ts`, on Node 22 through `fnm`): initializes and unlocks
   the four nodes, funds them with regtest BTC, issues 10,000.00 `DUSD` (NIA, precision 2) from
   dave's WDK treasury (`@utexo/wdk-wallet-rgb` 2.0.3), sends 100.00 `DUSD` on-chain to each
   traveler (the simulated on-ramp), opens six public 1,000,000-sat channels (a 50.00 trip
   channel from each traveler to dave, a 30.00 liquidity channel from dave to each traveler),
   and mines until all six are usable.

Node passwords and mnemonics are generated by the seed and written to
`infra/.secrets/nodes.json` (mode 0600, gitignored); non-secret ids (asset id, pubkeys, channels)
go to `infra/.out/seed-state.json`.

### 3. Run the app

```sh
pnpm dev            # relay :4000 + agents :4100 (KITTY_FAKES unset) + web :5173
```

Open the same `?as=` URLs as above. On first start the agents publish the trip (`TRIP_CREATED`,
the rate of the day, members, `CHANNELS_READY`) to the relay, and the on-device AI loads in the
background (a few seconds with the models cached). While it is not ready, reading a receipt
fails with a message and a suggested action; nothing else is blocked.

To walk through the demo, see [demo-walkthrough.md](demo-walkthrough.md).

### Stopping and restarting

```sh
pnpm infra:down     # stop the containers, keep the data
pnpm infra:up       # start again
pnpm demo:unlock    # unlock the 4 nodes after a restart and reconnect the peers to dave
```

Any run of `pnpm e2e:demo`, `e2e:liquidity`, `e2e:onchain`, `e2e:lose-phone`, `e2e:close` or
`demo:lose-phone` changes the regtest state for good (for example, charlie is excluded): run
`pnpm demo:reset` before the next demo.

## Configuration

The agent reads its configuration from the environment once, validated by zod
(`apps/agent/src/config.ts`). Every variable has a default, so nothing is required for local use.

| Variable                         | Default                           | Meaning                                                             |
| -------------------------------- | --------------------------------- | ------------------------------------------------------------------- |
| `KITTY_FAKES`                    | `0`                               | `1` = fake wallet and AI (development only)                         |
| `KITTY_RAIL_MODE`                | `ln-2ch`                          | `ln-2ch`, `ln-lsp` or `onchain` (only `ln-2ch` is used in the demo) |
| `KITTY_WALLET_ENGINE`            | `rln-rest`                        | `rln-rest` (used) or `wdk` (kept in the type, not used)             |
| `AGENT_HOST`, `AGENT_PORT`       | `127.0.0.1`, `4100`               | agent HTTP server                                                   |
| `RELAY_URL`                      | `http://127.0.0.1:4000`           | relay                                                               |
| `RLN_ALICE_URL` … `RLN_DAVE_URL` | `http://127.0.0.1:3001` … `:3004` | each member's node; each agent gets only its own                    |
| `ESPLORA_URL`                    | `http://127.0.0.1:3010`           | Esplora REST, for on-chain proofs (`/tx/<txid>`)                    |
| `SILENT_ASSENT_SECONDS`          | `45`                              | contest window before silent assent (production: hours)             |
| `PAYMENT_DEADLINE_SECONDS`       | `120`                             | from `LINE_SEEN` to overdue                                         |
| `INVOICE_EXPIRY_SECONDS`         | `3600`                            | Lightning invoice expiry                                            |

The relay reads `RELAY_HOST` (`127.0.0.1`), `RELAY_PORT` (`4000`), `RELAY_DB`
(`data/relay.sqlite`, relative to `apps/relay`) and `KITTY_FAKES` (`apps/relay/src/index.ts`).
Both read `LOG_LEVEL` (`info`). The AI reads `QVAC_CACHE_DIR`.

`infra/.env.example` lists the infra and seed variables with their defaults. The scripts do not
load an `.env` file by themselves: export a variable in your shell to override it.

The timers are written into the trip when it is created. If you restart `pnpm dev` with different
`SILENT_ASSENT_SECONDS` or `PAYMENT_DEADLINE_SECONDS` on the same relay database, the agent exits
with a message telling you to run `pnpm demo:reset` (`StaleRelayError`).
