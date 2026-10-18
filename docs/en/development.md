# Development

This page is for developers who want to change kit+ty: repository conventions, every root
script and what it does, the layers of tests and how to run each one, and what CI checks. It
assumes the prerequisites of [getting-started.md](getting-started.md).

## Conventions

- **pnpm workspace** (`pnpm-workspace.yaml`): `packages/*` and `apps/*`. TypeScript everywhere,
  ES modules, sources run directly with `tsx` (no build step except `apps/web`).
  `infra/treasury` is a separate npm project on Node 22 with its own lockfile.
- **Money is `bigint`**, in minor units (1 cent = 1 `DUSD` unit), and a decimal string on the
  wire through the money codec of `packages/shared/src/money.ts`. ESLint enforces it: in the
  ledger and the money modules of `shared`, `number` amounts, `z.number()`, `Math.round`,
  `parseFloat` and similar are errors (`eslint.config.js`, proven by
  `packages/ledger/src/lint-rules.test.ts`); in the other schema files, `z.number()` is an error on
  any property whose name says it is money.
- **Every AI output goes through zod**, at most 2 attempts, then the `ok: false` path.
- **Rules live in the ledger** as pure functions with tests; the relay and the agents call them.
- **Every event is signed** by its author and verified by whoever receives it.
- **Fakes** exist only behind `KITTY_FAKES=1`, refuse to be constructed otherwise, and the demo
  scripts refuse them.
- **Names**: travelers `alice`, `bob`, `charlie`; coordinator `dave`. No real people or companies
  in code, UI or data. Code, comments, commits and UI text are in English.
- **Regtest only.** Never commit `.env`, mnemonics, passwords, models, Docker volumes or backups
  (see `.gitignore`).
- **Git**: one branch per task, `<stream>/<ID>-<short-name>`; small Conventional Commits
  (`feat(ledger): derive line states`); PRs titled `[ID] …`, merged when CI is green; no force
  pushes, no direct pushes to `main`. Dependency changes go in their own PR.

## Scripts

All from the repository root (`package.json`).

| Script                          | What it does                                                                                         |
| ------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `pnpm typecheck`                | `tsc` in every workspace package                                                                     |
| `pnpm lint`                     | ESLint on the whole repo (including `infra/treasury`)                                                |
| `pnpm test`                     | Vitest unit and property tests of every package and app; no Docker, no models                        |
| `pnpm format`                   | Prettier on the whole repo, Markdown included                                                        |
| `pnpm dev`                      | relay, agent and web in parallel, in watch mode                                                      |
| `pnpm dev:fakes`                | the same with `KITTY_FAKES=1` (fake wallet, fake AI, permissive relay)                               |
| `pnpm rln:gen`                  | regenerate `packages/rln-client/src/schema.d.ts` from `docs/vendor/rln-openapi.yaml`                 |
| `pnpm infra:up`                 | start the regtest stack and wait for every service (needs the `settleup/rln:d4762ac` image)          |
| `pnpm infra:down`               | stop the stack, keep the data                                                                        |
| `pnpm infra:reset`              | wipe all regtest data (volumes) and start a cold stack                                               |
| `pnpm infra:check`              | stack acceptance probe: containers, height, Esplora, RLN, proxy, mining, `127.0.0.1` bindings        |
| `pnpm demo:reset`               | refuse fakes, wipe stack, treasury and relay database, then seed the demo                            |
| `pnpm demo:unlock`              | unlock the 4 nodes with the saved passwords, reconnect peers, wait for usable channels               |
| `pnpm demo:lose-phone <member>` | stop a member's node for good and restore a new one from the relay backup (needs `pnpm dev` running) |
| `pnpm e2e:wallet`               | integration tests of the real wallet against running, unlocked nodes (`*.integration.ts`)            |
| `pnpm e2e:close`                | **irreversible**: closes charlie's channels and checks the sweep (`close.destructive.ts`)            |
| `pnpm e2e:demo`                 | **irreversible**: the demo, steps 1-7, through the agent API on the real stack, with the real AI     |
| `pnpm e2e:liquidity`            | **irreversible**: a 35.00 line above L makes dave open liquidity just in time                        |
| `pnpm e2e:onchain`              | **irreversible**: bob pays alice 1.00 with the on-chain RGB rail                                     |
| `pnpm e2e:lose-phone`           | **irreversible**: bob pays, backs up, loses the phone, is restored, pays again                       |
| `pnpm ai:eval`                  | the real models on the receipt fixtures and the demo sentences                                       |
| `pnpm ai:eval:hard`             | the same on the hard fixtures (stress test, not a gate)                                              |
| `pnpm ai:eval:offline`          | `ai:eval` with the network blocked by macOS `sandbox-exec`                                           |

Workspace-level scripts: `pnpm --filter @kitty/web build` (Vite build) and
`pnpm --filter @kitty/web shots` (Playwright screenshots of every screen into
`apps/web/.shots/`, against a running `pnpm dev:fakes` with an empty relay database).

## Tests

| Layer               | Where                                                                                                                                                                              | Runs with         | Needs                                                    |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------- | -------------------------------------------------------- |
| Unit                | `*.test.ts` next to the code in every package and app                                                                                                                              | `pnpm test`       | nothing                                                  |
| Property            | fast-check in `packages/ledger/src/properties.test.ts` (shares sum to the converted total, nets sum to zero) and `packages/ledger/test/kitty.test.ts`                              | `pnpm test`       | nothing                                                  |
| Contract and wiring | relay against an in-memory database, agent routes and flows against an in-memory relay and fake RLN nodes (`apps/agent/src/flows/test/`, `apps/agent/src/wallet/test/fake-rln.ts`) | `pnpm test`       | nothing                                                  |
| Wallet integration  | `apps/agent/src/wallet/rln-wallet.integration.ts`                                                                                                                                  | `pnpm e2e:wallet` | the stack up and unlocked                                |
| Destructive         | `apps/agent/src/wallet/close.destructive.ts`                                                                                                                                       | `pnpm e2e:close`  | the stack after `demo:reset`                             |
| End to end          | `apps/agent/src/e2e/{demo,liquidity,onchain,lose-phone}.e2e.ts`                                                                                                                    | `pnpm e2e:<name>` | the stack after `demo:reset`, plus the models for `demo` |
| AI evaluation       | `apps/agent/src/ai/eval.ts`                                                                                                                                                        | `pnpm ai:eval*`   | the models in the local cache                            |

`pnpm test` currently runs 583 tests in 56 files. The `demo`, `liquidity` and `lose-phone` e2e
suites start their own relay and agent as child processes on ports 4400 and 4500 with a temporary
relay database, so they never touch the relay of `pnpm dev`, and pin the timers to 20/30 s
whatever the environment says; `onchain` drives two wallets directly, without agents. Their output goes to the terminal and to
`infra/.out/logs/<date-time>-e2e-<name>.log`, with the relay and agent output in a
`…-processes.log` next to it; `e2e:demo` also writes a summary to `infra/.out/e2e-demo.json`.

Every `e2e:*` suite except `e2e:wallet` changes the regtest state for good: run
`pnpm demo:reset` before the next run or the next demo. `e2e:wallet` makes small payments
between alice and bob that leave their `DUSD` balances unchanged but move channel sats.

## CI

`.github/workflows/ci.yml`, on every pull request and on pushes to `main`, on `ubuntu-latest`
with the Node version from `.node-version`:

```sh
corepack enable
pnpm install --frozen-lockfile
pnpm typecheck
pnpm lint
pnpm test
```

CI does not run Docker, the RLN nodes, the models or any `e2e:*` suite; those run on the demo
machine before risky merges.
