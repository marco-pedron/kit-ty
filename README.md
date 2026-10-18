<p align="center">
  <img src="apps/web/src/assets/kitty-wordmark.svg" alt="kit+ty" width="280">
</p>

<p align="center"><em>The shared kitty for group trips, with no one holding the money.</em></p>

kit+ty is our project for the _Agentic Dollars on Bitcoin_ hackathon (BLOX Torino, 17–18 October 2026). It runs on Bitcoin regtest and was built by Paolo ([@PaoSte](https://github.com/PaoSte)), Federico ([@federicopapantuono](https://github.com/federicopapantuono)) and Marco ([@marco-pedron](https://github.com/marco-pedron)).

## The idea

On organised group trips, shared costs tend to end up in one of two places. Either they go into the coordinator's cash envelope, with a single custodian and little visibility, or someone pays upfront and spends the rest of the trip chasing strangers to be paid back. kit+ty replaces both, and it is meant to be sold B2B2C to group tour operators.

Each traveler opens an RGB Lightning channel to the tour operator's node and puts their own digital dollars in it. That channel is their budget for the trip, and only they can spend it: nobody, not even the operator, holds anyone else's funds.

When someone pays for the group, they photograph the receipt. QVAC reads it on the device, and a sentence like _"Bob and I had the pho, Charlie only beers, water for all three"_ becomes a split per person. The AI only proposes who had what; the ledger computes every cent, in deterministic code.

Each traveler has an agent that checks the expense and pays the payer back over Lightning within seconds. It does this by silent assent, as long as the amount stays under limits the traveler chose for each line and each day. Above those limits the traveler approves explicitly, or contests the line and lets the coordinator decide.

If someone never pays, the coordinator settles the same invoice with the operator's liquidity, up to a guarantee cap, and excludes the member by closing their channels. Their funds go back to them on-chain: exclusion is a sanction, and the guarantee is what makes the creditor whole.

Underneath, every event is signed by its author and hash-chained on a relay that cannot forge anything, and every payment carries a preimage proof that anyone can check. Or, as we put it in the pitch:

> _"The coordinator can be annoying, but he can't steal."_

## Documentation

The English documentation starts at [`docs/en/index.md`](docs/en/index.md), with a two-minute overview and a clear account of what is real and what is simulated. From there, [getting started](docs/en/getting-started.md) shows how to run the app, first with simulated wallets and then on the real regtest stack. [How it works](docs/en/how-it-works.md), the [architecture](docs/en/architecture.md) and the [security model](docs/en/security-model.md) explain the design; the [API reference](docs/en/api-reference.md) and the [AI pipeline](docs/en/ai-pipeline.md) go into the details. The [demo walkthrough](docs/en/demo-walkthrough.md) replays the demo step by step, and [limitations and roadmap](docs/en/limitations-and-roadmap.md) says what is not there yet.

The full product and technical spec, the internal source of truth, is [`docs/SPEC.md`](docs/SPEC.md), in Italian.

## How it is built

Every member, from the three travelers to the coordinator, has their own `rgb-lightning-node` (pinned at commit `d4762ac`), running in Docker and driven over REST. The digital dollar is `DUSD`, an RGB NIA asset with precision 2 that stands in for USD₮. The operator's on-chain treasury, which issues `DUSD` and sells it to travelers, uses Tether's WDK. The receipt reading and the split run locally with Tether's QVAC.

| Layer                 | Technology                                                                                                                |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Bitcoin and RGB       | Bitcoin Core 30.2 (regtest), electrs 0.11.0, Esplora, `rgb-proxy-server` 0.3.0, RGB NIA asset `DUSD`                      |
| Lightning and wallets | `rgb-lightning-node` `d4762ac` for every member; WDK `@utexo/wdk-wallet-rgb` 2.0.3 on Node 22 for the operator's treasury |
| Local AI              | QVAC `@qvac/sdk` ~0.21.0: Latin OCR and Qwen3 1.7B Instruct Q4                                                            |
| Backend               | TypeScript on Node 22, Fastify for the agent and the relay, an append-only SQLite log, zod                                |
| Frontend              | React 19, Vite, Tailwind 4                                                                                                |
| Tooling               | pnpm workspaces, Vitest and fast-check, ESLint, Prettier, Claude Code                                                     |

Node 22 is a hard requirement: the native binary behind `wdk-wallet-rgb` does not compile on Node 24.

## Try it

The quickest way to look around is the simulated mode, which replaces the Lightning wallets and the AI with in-memory fakes and needs no Docker:

```sh
pnpm install
rm -f apps/relay/data/relay.sqlite*      # start from an empty relay database
pnpm dev:fakes                           # relay, agents and web on :5173
open "http://127.0.0.1:5173/?as=alice"   # also ?as=bob, ?as=charlie, ?as=dave
```

Always start `pnpm dev:fakes` from an empty relay database. The fake wallet keeps its invoices in the agent's memory, so after a restart the agents cannot verify the events left by a previous run. They reject the log from the first `MEMBER_JOINED`, and the app shows no members, an empty QR code and the red banner "The relay sent an entry this phone rejects". Stopping the stack, deleting the database and starting again fixes it.

To run on real RGB Lightning nodes, build the node image once, then reset the demo and start the app with `pnpm demo:reset` and `pnpm dev`. The reset also wipes the relay database. The steps and the prerequisites are in [getting started](docs/en/getting-started.md).

## Prior work (declared)

Some of the work happened before the hackathon, and we want to be explicit about it. When the hackathon started, nothing in this repository's apps and packages had been written yet.

The first piece is a previous prototype, "settleup-trip" (14–15 October): a custodial version of the same idea, which we abandoned in favour of self-custodial channels. Its useful code sits in [`_legacy/`](_legacy) as reference only, copied and adapted, never imported. It contained:

- a pnpm monorepo with a typed RLN client generated from the OpenAPI spec;
- the regtest Docker stack and its scripts (`infra:up/down/reset/check`, mining, funding);
- an RGB seed script (init, unlock, fund, issue the NIA `DUSD`, distribute) and an on-chain RGB payment rail, tested end to end (Bob → Alice 5.00, confirmed on regtest);
- the money ledger: exact FX with rational rates, receipt split with items, tax, tip and largest-remainder rounding, balances and a settlement plan, all in `bigint` cents, with 117 tests, about 99% coverage and property tests;
- a QVAC smoke test (OCR and LLM ready offline) and a fake AI service for development;
- a web app skeleton (React, Vite and Tailwind, with no screens).

On 16 October we also ran two spikes. The Lightning RGB spike ([`docs/spike-lightning.md`](docs/spike-lightning.md), with the exact requests that work) verified the whole path end to end on the regtest stack, with the RLN image built from the pinned upstream commit. It opened RGB channels with `DUSD` in both directions between a traveler and the operator, routed a payment from Alice to Bob through Dave in 3.4 s with no blocks mined, and confirmed that the payer gets the preimage and that the payee's key can be read from the invoice. It also closed a channel cooperatively with the `DUSD` swept back on-chain, and restored an encrypted backup onto a fresh node. The QVAC models were already cached and running offline, loading OCR and Qwen3 in about 7 s and answering with Wi-Fi off.

The WDK spike ([`docs/spike-wdk.md`](docs/spike-wdk.md)) tried `@utexo/wdk-rgb-lightning` `0.1.0-beta.15` as every member's node. It ran four nodes in one process and routed RGB payments, but its signer state did not survive a restart, cooperative closes did not sweep the `DUSD` back on-chain, and VSS restore hung. We kept the RLN REST engine for the nodes and used `@utexo/wdk-wallet-rgb` for the operator's treasury.

Finally, the design and planning documents (spec, work plan, pitch and session prompts) predate the hackathon too. There were no UI designs or mobile app at that point.

## Internal documents

The working documents of the team are in Italian.

| Document                                                       | What it is                                   |
| -------------------------------------------------------------- | -------------------------------------------- |
| [`docs/SPEC.md`](docs/SPEC.md)                                 | How kit+ty works: the source of truth        |
| [`docs/PLAN.md`](docs/PLAN.md)                                 | Who does what, when, and with which priority |
| [`docs/PITCH.md`](docs/PITCH.md)                               | The pitch and our answers to hard questions  |
| [`docs/spike-lightning.md`](docs/spike-lightning.md)           | Lightning RGB spike results                  |
| [`docs/spike-wdk.md`](docs/spike-wdk.md)                       | WDK engine spike results                     |
| [`docs/SETUP.md`](docs/SETUP.md)                               | Repository setup and session start           |
| [`docs/prompts/`](docs/prompts), [`docs/status/`](docs/status) | Session prompts and progress per stream      |
| [`CLAUDE.md`](CLAUDE.md)                                       | Rules for Claude Code                        |
