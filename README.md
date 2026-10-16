# kit+ty

**The shared kitty for group trips, with no one holding the money.**

Project for the *Agentic Dollars on Bitcoin* hackathon (BLOX Torino, 17–18 October 2026). Runs on Bitcoin **regtest**.

## Team

| Name | GitHub |
|---|---|
| Paolo | [@PaoSte](https://github.com/PaoSte) |
| Federico | [@federicopapantuono](https://github.com/federicopapantuono) |
| Marco | [@marco-pedron](https://github.com/marco-pedron) |

## The idea

On organised group trips, shared costs end up either in the coordinator's cash envelope (one custodian, opaque) or with someone paying upfront and chasing strangers afterwards. kit+ty fixes both, sold B2B2C to group tour operators:

- **Self-custodial budget.** Each traveler opens an RGB Lightning channel to the tour operator's node with their own digital dollars. Only they can spend it; nobody, not even the operator, holds anyone else's funds.
- **Local AI splits the bill.** The payer photographs the receipt; QVAC reads it **on the device** and turns a sentence like *"Bob and I had the pho, Charlie only beers, water for all three"* into per-person shares. The ledger, not the LLM, computes the money.
- **Agents pay within user-set limits.** Each traveler's agent verifies the expense and pays the payer over Lightning in seconds, by silent assent under a per-line and daily limit; above it, the traveler approves explicitly or contests.
- **Operator guarantee.** If someone doesn't pay, the coordinator settles the same invoice with the operator's liquidity (up to a cap) and excludes the member by closing their channels. Their funds go back to them on-chain.
- **Signed, verifiable log.** Every event is signed by its author and hash-chained on a relay that can't forge anything; every payment carries a preimage proof.

> *"The coordinator can be annoying, but he can't steal."*

Full product and technical spec (roles, event log, payments, security, architecture, demo script): **[`docs/SPEC.md`](docs/SPEC.md)** (in Italian).

## Stack

| Layer | Technology |
|---|---|
| Bitcoin / RGB | Bitcoin Core 30.2 regtest, electrs 0.11.0, esplora, `rgb-proxy-server` 0.3.0, RGB NIA asset `DUSD` (stand-in for USD₮, precision 2) |
| Lightning RGB node | `rgb-lightning-node` at commit `d4762ac` (Docker, REST); Tether **WDK** modules `@utexo/wdk-rgb-lightning` `0.1.0-beta.15` + `@utexo/wdk-wallet-rgb` as the per-member wallet (under evaluation) |
| Local AI | Tether **QVAC** `@qvac/sdk` ~0.21.0: OCR (Latin) + Qwen3 1.7B Instruct Q4 (Qwen3 0.6B as fast fallback) |
| Backend | TypeScript, Node ≥ 22.17, Fastify (agent + relay), SQLite append-only log, zod |
| Frontend | React 19, Vite, Tailwind 4 |
| Tooling | pnpm workspaces, vitest + fast-check, ESLint, Prettier, Claude Code |

### Already installed and working (as of 16 October)

- **Regtest stack** (bitcoind, electrs, esplora REST, RGB proxy) via Docker Compose, with the RLN image built locally from the pinned upstream commit.
- **RGB Lightning, verified end to end** in our spike ([`docs/spike-lightning.md`](docs/spike-lightning.md)): RGB channels with DUSD opened traveler → operator and operator → traveler (two channels per pair), a routed payment Alice → Dave → Bob in **3.4 s with no blocks mined**, preimage available to the payer, payee pubkey checkable from the invoice, cooperative close with DUSD swept back on-chain, encrypted backup and restore on a fresh node.
- **QVAC models cached and running offline**: OCR + Qwen3 load in ~7 s and answer with Wi-Fi off.
- **WDK spike** (16 October afternoon), results in [`docs/spike-wdk.md`](docs/spike-wdk.md): `@utexo/wdk-rgb-lightning` `0.1.0-beta.15` runs four in-process nodes and routes RGB payments, but its signer state does not survive a restart, cooperative closes don't sweep DUSD back on-chain, and VSS restore hangs. We kept the RLN REST engine and use `@utexo/wdk-wallet-rgb` for the operator treasury.

## Prior work (declared)

Everything below was done **before the hackathon**; nothing in the new repo's apps/packages is written yet.

- **Previous prototype ("settleup-trip", 14–15 October)**, a custodial version of the same idea that we abandoned in favour of self-custodial channels. Its useful code is in [`_legacy/`](_legacy) as reference only (copied and adapted, never imported):
  - pnpm monorepo, typed RLN client generated from the OpenAPI spec;
  - regtest Docker stack and scripts (`infra:up/down/reset/check`, mining, funding);
  - RGB seed script (init, unlock, fund, issue NIA `DUSD`, distribute) and an **on-chain RGB payment rail**, tested end to end (Bob → Alice 5.00, confirmed on regtest);
  - **money ledger**: exact FX with rational rates, receipt split (items, tax, tip, largest-remainder rounding), balances, settlement plan, all in `bigint` cents; 117 tests, ~99% coverage, property tests;
  - QVAC smoke test (OCR + LLM ready offline) and a fake AI service for development;
  - web app skeleton only (React + Vite + Tailwind, no screens).
- **Lightning RGB spike** (16 October morning): results above, with the exact working requests in [`docs/spike-lightning.md`](docs/spike-lightning.md).
- **Design and planning docs**: spec, work plan, pitch, session prompts (below). No UI designs or mobile app yet.

## Documents

| Document | What it is |
|---|---|
| [`docs/SPEC.md`](docs/SPEC.md) | How kit+ty works: the source of truth |
| [`docs/PLAN.md`](docs/PLAN.md) | Who does what, when, priorities |
| [`docs/PITCH.md`](docs/PITCH.md) | Pitch and answers to hard questions |
| [`docs/spike-lightning.md`](docs/spike-lightning.md) | Lightning RGB spike results |
| [`docs/SETUP.md`](docs/SETUP.md) | Repo setup and session start |
| [`CLAUDE.md`](CLAUDE.md) | Rules for Claude Code |
| [`docs/prompts/`](docs/prompts) · [`docs/status/`](docs/status) | Session prompts · progress per stream |
| [`docs/spike-wdk.md`](docs/spike-wdk.md) | WDK engine spike results |

*How to run it, and what is real vs simulated: to be completed on Sunday (task T2).*
