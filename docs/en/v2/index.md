# kit+ty v2

This is ongoing work on the v2 branch; the version presented at the final is on main.

This section of the documentation describes kit+ty v2 for readers who do not know the project.
v1, the version presented at the final, is described in the [main documentation](../index.md);
this page assumes only the idea. The v2 code is not on `main`: every code link here points to
the [`v2` branch](https://github.com/marco-pedron/kit-ty/tree/v2) on GitHub.

## kit+ty in one paragraph

kit+ty is the shared kitty of a group trip with no custodian. Each traveler keeps their own
digital dollars in an RGB Lightning channel. When someone pays for the group, they photograph the
receipt, an AI on the device reads it and splits it from a sentence, and the agent on each
debtor's phone pays the payer back within seconds, under limits the debtor chose. kit+ty settles
debts between the members of the group; it does not pay the restaurant.

## Why v2

v1 already keeps everyone's money in their own channel: nobody can spend someone else's funds.
But it still gives powers to one person and one server:

- the **coordinator** (`dave`, who works for the tour operator) admits members, sets the exchange
  rate, decides disputes, pays defaults with the operator's money and excludes members;
- the **relay** decides the order of the log, and if it goes down the group stops.

v2 removes both. There is **no member with special powers**: the rules are pure functions that
every phone runs on the same signed events and that give the same result everywhere. There is
**no single point of failure for the log**: it travels on three Nostr relays and every phone
keeps a full copy. The **operator is reduced to an LSP** (Lightning service provider): its node
routes payments and provides liquidity, but it is not a member, does not sign events and cannot
read the log.

## What changes from v1

| Topic            | v1 (on `main`, presented at the final)                                                                 | v2 (on the `v2` branch)                                                                                                                                                                 |
| ---------------- | ------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Coordinator      | `dave` creates the trip, admits members, publishes the rate, decides disputes, guarantees and excludes | No coordinator. A member creates the trip; `dave`'s node is only the LSP, outside the group                                                                                             |
| Relay            | One relay (Fastify + SQLite) that validates, orders and stores the log                                 | Three Nostr relays (strfry) that store and forward encrypted events; none of them orders anything. The old relay only keeps the encrypted node backups                                  |
| Log              | Hash chain: the relay assigns `seq` and `prevHash`                                                     | A graph: each event cites the events its author knew. Every phone computes the same order from the graph alone, never from arrival order or clocks. Every phone keeps a full local copy |
| Disputes         | The coordinator upholds or voids the line (`DISPUTE_RESOLVED`)                                         | The debtor withdraws the contest by approving after seeing it (rule C3), or the other members vote (`LINE_VOTED`, provisional rule: more than half of the voters)                       |
| Exclusion        | The coordinator excludes and closes the member's channels (`MEMBER_EXCLUDED`)                          | A member is excluded when more than half of the other active members block them. Exclusion is final; their debts stay and are paid by hand                                              |
| Guarantee        | The operator pays a defaulting debtor's invoice with its own liquidity, up to a cap (`GUARANTEE_PAID`) | No replacement yet. An unpaid debt stays visible to everyone and is paid by hand. A guarantee nobody holds is on the roadmap                                                            |
| Closing the trip | The coordinator publishes `TRIP_CLOSED` (the event exists, no flow publishes it)                       | Nobody decides. Each member leaves (`MEMBER_LEFT`, only with no known debts) and closes their own channels; the trip is closed when everyone has left                                   |
| Signatures       | ed25519 app key, bound to the node by an invoice                                                       | Schnorr (BIP-340, secp256k1), the Nostr signature, with a key derived per trip from the member's seed (NIP-06), bound to the node by a `kitty-bind:v2` invoice                          |
| Encryption       | None: the relay reads every event                                                                      | Every event is encrypted with NIP-44 under a key only the members know. The relays see sizes, times and per-trip keys, not amounts, names or nodes                                      |

The details of each rule are in [how it works](how-it-works.md); the components and keys are in
the [architecture](architecture.md).

## Current state

What works on the `v2` branch today, with `KITTY_REGISTRY=v2` (the default is still `v1`):

- **The registry v2** (steps 1 to 4 of the migration plan): Nostr envelope with Schnorr
  signatures, NIP-44 encrypted content, fixed order computed from the graph, conflict rules
  C1–C15 as pure tested functions, invitations, blocks, majority exclusion, contests by majority,
  exit, per-trip keys and recovery from the seed.
- **The agents on the registry v2**: each traveler is a `RegistryAgent` that sees, decides, pays
  by silent assent within its limits, checks every invoice against the creditor's node, reissues
  expired invoices and backs up its node. `dave` is an `LspAgent` that only routes and refills
  liquidity from its own channels; its old coordinator routes answer `NOT_ALLOWED`.
- **The Nostr transport**: three strfry relays in Docker, a full local copy on every phone,
  missing events fetched from the relays, a relay that comes back gets what it missed, and
  checkpoints compared on every phone ("same on 3/3", reported by each agent; not yet shown in the UI).
- **The UI** shows the v2 actions: block and unblock a member, vote on someone else's contested
  line, leave the trip.

Two end-to-end suites prove it on the real regtest stack (real RGB Lightning nodes, real
on-device AI):

| Command                                     | What it proves                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm demo:reset && pnpm e2e:demo:v2`       | The whole demo story on the registry v2: AI reading, split 3.09 / 3.09 / 3.50, a contest and its withdrawal (C3), automatic payment after silent assent with no block mined, `dave`'s coordinator routes refused, a relay stopped halfway and back with every event it missed, encrypted node backups, "same state on 3/3" from the checkpoints, every member leaving with their `DUSD` back on-chain, trip closed on every phone. Script: [`demo-v2.e2e.ts`](https://github.com/marco-pedron/kit-ty/tree/v2/apps/agent/src/e2e/demo-v2.e2e.ts) |
| `pnpm demo:reset && pnpm e2e:lose-phone:v2` | Bob loses the phone: a new node is restored from the encrypted backup with the same balance, the new phone has no copy of the registry and finds the trip again from the seed alone, on the Nostr relays, and a new payment works. Script: [`lose-phone.e2e.ts`](https://github.com/marco-pedron/kit-ty/tree/v2/apps/agent/src/e2e/lose-phone.e2e.ts)                                                                                                                                                                                           |

What is still the same as v1: Bitcoin regtest only, `rgb-lightning-node` over REST in Docker
(not yet a node on the phone), all agents in one process on one laptop, `DUSD` with precision 2
standing in for USD₮. The step-by-step story is in the [demo walkthrough](demo-walkthrough.md);
the declared limits and the roadmap are in [limitations and roadmap](limitations-and-roadmap.md).

## Pages

| Page                                                  | What it covers                                                                                                                                             |
| ----------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [Architecture](architecture.md)                       | The phone (agent, registry, node), the Nostr relays, the LSP, the blockchain; keys, encryption, the `Transport` interface; what happens when a relay stops |
| [How it works](how-it-works.md)                       | The life of an expense and the rules: blocks, exit, contests and votes, exclusion                                                                          |
| [Demo walkthrough](demo-walkthrough.md)               | The v2 demo step by step, from `demo-v2.e2e.ts`                                                                                                            |
| [Limitations and roadmap](limitations-and-roadmap.md) | The declared limits and the full roadmap                                                                                                                   |

## Sources

The design notes behind these pages are in Italian, on the `v2` branch:
[ADR-001, event format](https://github.com/marco-pedron/kit-ty/tree/v2/docs/ADR-001-formato-eventi.md),
[conflict rules](https://github.com/marco-pedron/kit-ty/tree/v2/docs/proposte/regole-conflitto.md),
the [migration plan](https://github.com/marco-pedron/kit-ty/tree/v2/docs/piano-migrazione-stack-a.md)
and the other [proposals](https://github.com/marco-pedron/kit-ty/tree/v2/docs/proposte).
