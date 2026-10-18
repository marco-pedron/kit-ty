# Security model

This page states what kit+ty protects, against whom, and how, for reviewers who want to judge the
trust assumptions. It covers self-custody, the signed and hash-chained event log, what the relay
can and cannot do, payment proofs, the agent's limits, backups, and what is out of scope. Each
defence points to the code that implements it. Everything here runs on Bitcoin **regtest** only;
nothing has been audited, and nothing should be pointed at mainnet or real funds.

## Trust assumptions in one table

| Party                                | Trusted for                                                                                   | Not trusted for                                                                                       |
| ------------------------------------ | --------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Traveler's own device (agent + node) | holding their keys and funds; deciding to pay                                                 | nothing else: it verifies everything it receives                                                      |
| dave (operator)                      | routing payments; publishing the rate of the day; resolving disputes; honouring the guarantee | moving travelers' funds (it cannot), signing for them (it cannot), inventing events (they are signed) |
| Relay                                | delivering events (availability only)                                                         | content: every event is signed by its author and re-validated by every agent and by the browser       |
| The on-device AI                     | proposing receipt rows and item assignments                                                   | money: the ledger computes every amount, and the debtor approves amounts, not the sentence            |

> "dave can be annoying, but he can't steal."

## Self-custody

- Each traveler funds their **own** trip channel with their own `DUSD`. Only their node can sign
  an outgoing payment from it. dave's node is the counterparty of the channel but cannot spend the
  traveler's side.
- dave's liquidity channel to each traveler holds the operator's `DUSD`; it lets the traveler
  receive. Those funds remain the operator's until routed.
- There is no pooled balance and no custodian. No view exposes another member's balance: the
  `TripView` returns only `me.balance` (`packages/shared/src/views.ts`); dave's view shows member
  status and guarantee usage, not balances.
- A traveler can always leave by closing their channel; when dave excludes someone, the close is
  cooperative (`force: false`, `apps/agent/src/wallet/rln-wallet.ts`) and the funds are swept
  back to the member on-chain.

## The signed, hash-chained log

Every state change is an event (`packages/shared/src/events.ts`):

```text
SignedEvent  = { inner, sig }
inner        = { v: 1, tripId, type, author, nonce (16 random bytes), createdAt, body }
sig          = ed25519 signature of canonical(inner) by `author`

StoredEvent  = { seq, prevHash, signed, receivedAt, hash }
hash         = sha256(canonical({ seq, prevHash, signed }))
prevHash(1)  = 64 zeros
```

- **Canonical JSON** is RFC 8785 (JCS), with bigints as decimal strings and no floats
  (`packages/shared/src/canonical.ts`).
- **Signatures** are ed25519, verified strictly per RFC 8032 (no ZIP-215 leniency) so the relay,
  the agents and the browser accept exactly the same signatures (`packages/shared/src/crypto.ts`).
- **Who signs.** RLN's `/signmessage` at `d4762ac` signs the empty string whatever the input, so
  it is never used. Each member's app holds an ed25519 key (`appPubkey`), derived from the node
  mnemonic with HKDF-SHA256, which is the `author` of their events. It is bound to the node by
  the `bindInvoice` of `MEMBER_JOINED`: an invoice created by the member's own node with
  description `kitty-bind:<sha256(appPubkey)>`. Its signed `payee_pubkey` must equal the declared
  `nodePubkey` (`checkBindInvoice`).
- **Anti-replay.** Each event carries the trip id and a nonce never seen in the trip (also a
  `UNIQUE` column in the relay); events about an expense reference its `expenseEventHash` and the
  exact amount, so a signature is useless in any other context.
- **Roles.** `EVENT_AUTHOR` in `events.ts` fixes who may sign each type (coordinator, member,
  debtor, payer, any). `validateEvent` enforces it: for example `GUARANTEE_PAID` only from dave,
  `LINE_DECIDED` only from that line's debtor, `EXPENSE_VOIDED` only from the payer.

### `validateEvent`: the same rules everywhere

`validateEvent(stored, trip, deps)` (`packages/ledger/src/validate.ts`) is pure: the signature
verifier and the invoice decoder are injected. It runs on the relay before storing, in every
agent on everything it receives, and its chain and signature part is recomputed in the browser.
It checks, among others:

- chain position, hash and signature; the log starts with `TRIP_CREATED`; one trip per chain;
  nonce unused; trip not closed;
- author role and admission; coordinator-only types; no excluded member as author or debtor;
- `EXPENSE_SUBMITTED`: receipt totals; the rate equals the referenced `RATE_SET`; the shares
  recomputed by the ledger from the receipt, item indexes and rate equal the signed ones;
  `Σ lines + payerCents = totalUsdCents`; the fingerprint is not a duplicate; every invoice
  decodes, is payable to the payer's registered node, is for the trip asset and the line amount,
  has not expired, and no two lines share one invoice;
- `LINE_SEEN` / `LINE_DECIDED`: the author is that line's debtor; amounts match; a contest needs
  a reason and an undecided line;
- `PAYMENT_MADE` / `GUARANTEE_PAID`: `paymentHash` is the one of the line invoice and
  `sha256(preimage) == paymentHash`; amount and creditor match; a guarantee covers only an
  overdue line and fits in what is left of G;
- `INVOICE_REISSUED`: only by the payer, only after the old invoice expired, with a new payment
  hash.

The relay's BOLT11 decoder (`apps/relay/src/bolt11.ts`) **always verifies the invoice signature**
and recovers the payee from it: the payee check would be worthless otherwise, since anyone can
write any pubkey in the `n` field. Agents decode invoices with their own node
(`/decodelninvoice`).

### What the relay can and cannot do

| The relay can                                                                            | The relay cannot                                                                             |
| ---------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| refuse an event or not deliver it (censorship, downtime)                                 | create or modify an event (it has no member key)                                             |
| delay delivery                                                                           | reorder or drop an event without breaking the chain every agent and browser recomputes       |
| serve different histories to different members (equivocation): mitigated, see below      | read a node backup (encrypted by the node)                                                   |
| overwrite the latest backup blob for a pubkey (uploads are not authenticated, see below) | rewrite stored rows: SQLite triggers abort any `UPDATE` or `DELETE` (`apps/relay/src/db.ts`) |

Equivocation: every agent publishes a `CHECKPOINT { seq, headHash }` every 10 events. The UI shows
the chain and signature check per phone; the cross-phone comparison ("same on N/N phones") is not
in the UI yet (`ledger.checkpoints` is always `null`), and `pnpm e2e:demo` asserts that all four
agents end on the same head.

## Payment proofs

A Lightning payment proof is `{ rail: "ln", paymentHash, preimage, cents, payeePubkey }`. The Proof
panel (`GET /api/proof/:paymentHash`, `apps/agent/src/routes/proof.ts`) shows three explicit
checks:

1. `sha256(preimage) = payment hash`;
2. invoice signed by the creditor's node (the decoded payee equals the creditor's registered
   `nodePubkey`);
3. amount and asset match the line.

The preimage is known only once the payee's node has settled the HTLC, so it proves payment to
whoever holds the invoice. A guarantee payment by dave carries the same kind of proof on the same
invoice. The on-chain rail's proof is a `txid`, checked on Esplora.

## Agent limits

The agent spends only within the policy its owner signed (`POLICY_UPDATED`):

- **per line**: above `autoPayLimitCents`, no silent assent; the owner must approve;
- **per day**: at most `dailyCapCents` paid automatically in a rolling 24 h;
- the limit is checked again right before paying, in case the policy changed;
- never contested, unverified, overdue or voided lines; never if the expense totals do not add
  up; never an invoice that is not the one in the log, not payable to the creditor's node, for
  another asset or amount, or expired;
- the windows start at `LINE_SEEN`, so an expense posted while the debtor sleeps does not expire.

This also bounds the damage of a stolen phone to the limits until the owner asks dave to close the
channels.

## AI and prompt injection

The receipt text and the split sentence are untrusted input. The prompts tell the model to treat
them as data; the model's output is constrained by a JSON schema at sampling time and then by zod
to existing member names and item indexes; the model never writes amounts (for receipts it only
points to OCR rows; code parses the numbers). The debtor approves the resulting lines and amounts,
never the sentence. Before loading, the agent checks the sha256 of each model file in the local
cache against the checksum pinned by `@qvac/sdk` 0.21.0 and refuses a mismatch
(`apps/agent/src/ai/model-check.ts`). See [ai-pipeline.md](ai-pipeline.md).

## Backups

- With RGB a mnemonic alone does not recover funds; the client-side data is needed. Each traveler's
  agent runs RLN `/lock` → `/backup` → `/unlock` about 10 s after its node goes quiet after a
  change, and uploads the file to the relay (`PUT /backups/:pubkey`). The file is encrypted by RLN
  with the node password, which never leaves the device.
- Restoring an **old** channel state and using it can be punished as fraud in Lightning. The
  backup follows every change, and `demo:lose-phone` refuses to bring the lost node back online
  (`infra:up` refuses to start it until `demo:reset`). A loss within the 10 s window would restore
  a stale state; the safe alternative is a cooperative close with dave.
- **Known gaps:** the relay does not authenticate backup uploads (anyone who knows a pubkey can
  add a newer blob for it; older versions are kept, never overwritten in storage). dave's node is
  not backed up automatically, because RLN `d4762ac` occasionally hung after a lock/unlock cycle
  and dave is the hub.

## Infrastructure

- Every Docker port is published on `127.0.0.1` only; `pnpm infra:check` fails otherwise. The RLN
  nodes run with `--disable-authentication`, acceptable only because of that binding; RLN supports
  Biscuit tokens for production.
- `KITTY_FAKES=1` replaces the wallet, the AI and the relay's validation with fakes whose
  signatures anyone can forge. They refuse to be constructed unless the flag is set, the UI shows a
  banner, and `demo:reset` and the scenario suites run by `infra/scripts/e2e.sh` (`e2e:demo`,
  `e2e:liquidity`, `e2e:lose-phone`, `e2e:onchain`) refuse to run with it (`assertNoFakes`).
- Secrets (node passwords, mnemonics) are generated by the seed into `infra/.secrets/nodes.json`
  (mode 0600, gitignored), never printed; each agent receives only its own member's node URL and
  app key.

## Threat model

| #   | Threat                                         | Defence                                                                        | Status                                                      |
| --- | ---------------------------------------------- | ------------------------------------------------------------------------------ | ----------------------------------------------------------- |
| 1   | Network or server swaps the creditor's invoice | pay only if the invoice's signed payee is the creditor's registered node       | implemented                                                 |
| 2   | Relay invents or edits events                  | author signatures, re-validated everywhere                                     | implemented                                                 |
| 3   | Signature replayed in another context          | nonce, trip id, expense hash and amount inside the signature                   | implemented                                                 |
| 4   | Silent assent abused (expense posted at night) | windows start at `LINE_SEEN`; per-line limit; daily cap                        | implemented                                                 |
| 5   | Duplicate receipt                              | fingerprint over merchant, date, currency, total and photo hash                | implemented                                                 |
| 6   | Prompt injection in the sentence or receipt    | constrained output; the model never writes amounts; debtor approves amounts    | implemented, with hostile-sentence tests                    |
| 7   | Debtor never pays                              | deadline → operator guarantee → exclusion                                      | implemented                                                 |
| 8   | Contesting everything to avoid paying          | dave decides; abusers get excluded                                             | implemented                                                 |
| 9   | Fake or inflated receipt                       | photo hash committed; dave can ask to see the photo; exclusion                 | manual process                                              |
| 10  | dave manipulates the rate                      | `RATE_SET` signed with source and date; rate locked at submission; contestable | implemented                                                 |
| 11  | dave voids legitimate expenses                 | every void is a signed, visible event                                          | implemented                                                 |
| 12  | Relay shows different histories (equivocation) | `CHECKPOINT` events                                                            | events published; cross-phone comparison not in the UI      |
| 13  | Node API exposed                               | ports on `127.0.0.1`                                                           | implemented (production: Biscuit tokens)                    |
| 14  | Lost phone                                     | automatic encrypted backup on the relay + restore                              | implemented for travelers, not for dave                     |
| 15  | Stolen phone                                   | policy limits bound the damage; close channels on request                      | limits implemented; unlock for large amounts on the roadmap |
| 16  | dave broadcasts an old channel state           | watchtower independent of the operator                                         | roadmap                                                     |
| 17  | dave refuses to route                          | traveler closes the channel; direct on-chain rail                              | on-chain rail exists, not wired into the flows              |
| 18  | dave sees every payment (surveillance)         | acknowledged; multiple hubs and blinded paths                                  | roadmap                                                     |
| 19  | Tampered AI model                              | sha256 of the model files checked before loading                               | implemented                                                 |
| 20  | Node signature reused to impersonate a member  | `/signmessage` never used; app ed25519 keys bound by an invoice                | implemented                                                 |

## Out of scope

Mainnet, real funds, audits, watchtowers, multiple hubs, splicing, peer-to-peer event transport,
encrypted photo sharing, a native mobile app, and authentication of the agent HTTP API (it listens
on `127.0.0.1` and identifies the actor by the `:as` path segment, which is only acceptable because
all four agents run on one demo laptop).
