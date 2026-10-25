# kit+ty documentation

This is the English documentation of kit+ty, written for the hackathon judges and for developers
who want to run, verify or extend the project. It starts with a two-minute overview, then links to
one page per topic. Every claim here is meant to be checkable against the code: file paths are
given so you can do exactly that. The internal design notes in `docs/*.md` are in Italian and are
not required reading.

## kit+ty in two minutes

kit+ty is the shared kitty of a group trip with **no custodian**. It settles debts _between the
members of a group_ (it does not pay the restaurant).

- Each traveler (`alice`, `bob`, `charlie`) opens an **RGB Lightning channel** to the tour
  operator's node (`dave`) with their own digital dollars (`DUSD`, an RGB **NIA** asset with
  precision 2). Only they can spend it.
- The payer photographs a receipt. **QVAC runs OCR and an LLM on the device**; the payer writes a
  sentence such as _"Bob and I had the pho, Charlie only beers, water for all three"_. The AI
  proposes items and assignments; the **ledger, in deterministic `bigint` code, computes every
  cent**.
- Each debtor's **agent** verifies the expense and pays the payer's Lightning invoice (routed
  through `dave`) by **silent assent** if the amount is under the debtor's own limit. Above the
  limit, the debtor approves explicitly, or contests.
- If a debtor never pays, `dave` pays **the same invoice** with the operator's liquidity (the
  **operator guarantee**, up to a cap per member) and **excludes** the member by cooperatively
  closing their channels. Their funds go back to them on-chain.
- Every action is an event **signed** by its author (ed25519) and **hash-chained** by a relay that
  holds no key and cannot forge anything. Every Lightning payment carries a **preimage** proof that
  anyone can check.

> "The coordinator can be annoying, but he can't steal."

## Why it is technically interesting

- **Real RGB on Lightning.** RGB channels with an NIA asset, payments routed `alice → dave → bob`
  in about 3.4 s with no block mined, cooperative closes with the asset swept back on-chain,
  measured on Bitcoin regtest (`docs/spike-lightning.md`, `apps/agent/src/e2e/demo.e2e.ts`).
- **Agents with hard limits.** The decision to pay is a pure, tested function
  (`decideAutoPay` in `packages/ledger/src/autopay.ts`) that also writes the sentence the user
  reads ("Paid 3.09 to alice automatically: no objection in 20 s, under your limit of 20.00.").
- **The LLM never touches money.** For receipts, the model only says _which OCR row_ is an item or
  the total; code parses the amounts (`apps/agent/src/ai/receipt.ts`). For the split, the output
  is constrained to existing member names and item indexes; shares and FX are computed by the
  ledger.
- **Nobody trusts the relay.** The same `validateEvent` runs on the relay and in every agent, and
  the browser re-verifies the whole chain and every signature (`apps/web/src/verify.ts`).

## What is real and what is not

| Real                                                                                                 | Simulated or limited                                                                                                        |
| ---------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Every payment, channel open and close shown in the UI is a real RGB operation on Bitcoin **regtest** | Regtest only: no mainnet, no real funds                                                                                     |
| Signatures, hash chain, invoice and preimage checks                                                  | Four nodes and four agents run on one laptop; agents share one process (to load the AI once), each with only its own wallet |
| On-device AI (OCR + Qwen3 1.7B), works offline                                                       | `DUSD` stands in for USD₮; the on-ramp is done by the seed script                                                           |
| Encrypted node backup on the relay and restore on a new node                                         | The relay is local; the receipt photo shown in a dispute is shown in person                                                 |
|                                                                                                      | `KITTY_FAKES=1` development mode: fake wallet, fake AI, no RGB at all, with a visible banner. The demo scripts refuse it    |

Details: [limitations-and-roadmap.md](limitations-and-roadmap.md).

## Pages

| Page                                                  | What it covers                                                                      |
| ----------------------------------------------------- | ----------------------------------------------------------------------------------- |
| [Getting started](getting-started.md)                 | Prerequisites, the 2-minute quickstart with fakes, the real regtest stack           |
| [How it works](how-it-works.md)                       | Roles, the expense lifecycle, line states, auto-pay policy, guarantee and exclusion |
| [Architecture](architecture.md)                       | Monorepo map, components, data flow, stack and versions                             |
| [Security model](security-model.md)                   | Self-custody, the signed log, what the relay can and cannot do, threat model        |
| [API reference](api-reference.md)                     | Relay HTTP and SSE, agent HTTP API, event types, ledger functions, interfaces       |
| [AI pipeline](ai-pipeline.md)                         | QVAC OCR + LLM, prompts, zod validation and fallback, `pnpm ai:eval`                |
| [Development](development.md)                         | Conventions, every script, tests, CI                                                |
| [Demo walkthrough](demo-walkthrough.md)               | The demo stories step by step, with the commands to reproduce them                  |
| [Troubleshooting](troubleshooting.md)                 | Known failure modes and how to get out of them                                      |
| [Limitations and roadmap](limitations-and-roadmap.md) | Honest limits and what comes next                                                   |

## kit+ty v2

These pages describe v1, the version presented at the final. kit+ty v2, with no coordinator, the
group's ledger on three Nostr relays and the operator reduced to an LSP, is ongoing work on the
[`v2` branch](https://github.com/marco-pedron/kit-ty/tree/v2). It is summarised in Part 2 of the
[README](../../README.md#part-2--kitty-v2) and documented in [v2/](v2/index.md).
