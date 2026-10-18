# Demo walkthrough

This page walks through the kit+ty demo step by step, for judges who want to reproduce it and for
presenters. It has two stories on the same trip, "when it goes well" (a taxi) and "when it goes
wrong" (a dinner, with a dispute, a default, the operator guarantee and an exclusion), plus the
optional lost-phone step. Each step gives the screen, what to do, the event it produces on the
relay and what you should see. The numbers for story 2 are the ones asserted by
`pnpm e2e:demo` (`apps/agent/src/e2e/demo.e2e.ts`).

## Setup

```sh
pnpm demo:reset     # chain from scratch, seed, channels: about 80 s (needs the stack, see getting-started)
pnpm dev            # relay + agents + web, real nodes and real AI
```

Open four phone-sized windows:

```text
http://127.0.0.1:5173/?as=alice
http://127.0.0.1:5173/?as=bob
http://127.0.0.1:5173/?as=charlie
http://127.0.0.1:5173/?as=dave
```

Starting state: each traveler has 50.00 `DUSD` in their trip channel ("Only you can spend it"),
50.00 on-chain from the on-ramp, and 30.00 of dave's liquidity to receive. Trip "Vietnam 2026",
rate of the day from `infra/fixtures/rates.json` (26,350 VND and 0.86 EUR per 1 USD, a static
snapshot, not market data). Wait until the AI is ready (a few seconds).

Timers: with `pnpm dev` the contest window is **45 s** and the payment deadline **120 s**, both
from `LINE_SEEN`. `pnpm e2e:demo` uses 20 s and 30 s.

## Story 1: when it goes well (taxi)

Preparation: in charlie's Group settings, move the limit slider to 10.00 ("Pay automatically up to
10.00 DUSD"), which publishes `POLICY_UPDATED`. bob keeps the default limit of 20.00.

| #   | Who         | Do                                                       | Event                                   | You see                                                                                                                                                          |
| --- | ----------- | -------------------------------------------------------- | --------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | alice       | New expense, pick `infra/fixtures/receipts/eur-taxi.png` |                                         | "Reading on this device…" with elapsed time, then the editable rows (45.00 EUR with a 4.50 tip)                                                                  |
| 2   | alice       | Type "taxi split in three", then split                   |                                         | Parts per person computed by the ledger at the locked EUR rate: about 17.44 each of about 52.33 USD                                                              |
| 3   | alice       | Send                                                     | `EXPENSE_SUBMITTED`                     | Two payment requests signed by alice's node; "Owed to you" goes up                                                                                               |
| 4   | agents      | nothing                                                  | `LINE_SEEN` ×2                          | bob and charlie both get the notification with a countdown                                                                                                       |
| 5   | bob's agent | nothing                                                  | `PAYMENT_MADE`                          | When the window ends: "Paid … to alice automatically: no objection in 45 s, under your limit of 20.00." The Proof panel shows three ✓ and **no block was mined** |
| 6   | charlie     | Approve (above his 10.00 limit, so the agent waits)      | `LINE_DECIDED{approve}`, `PAYMENT_MADE` | "Needs your approval…", then "Paid … to alice: you approved it."                                                                                                 |
| 7   | everyone    |                                                          |                                         | The expense is settled; alice's activity lists both payments with proofs                                                                                         |

## Story 2: when it goes wrong (dinner)

This is the script of `pnpm e2e:demo`. Receipt: `infra/fixtures/receipts/vnd-dinner.png`,
255,000 VND (Pho bo x2 130,000, Bia Saigon x3 75,000, Water 30,000, tip 20,000) = 9.68 USD.

| #   | Who         | Do                                                                                                                                                                 | Event                                | You see                                                                                                                                                                                     |
| --- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | alice       | Photo of the dinner, then the sentence "Bob e io la pho, Charlie solo birre, l'acqua in tre" (or "Bob and I had the pho, Charlie only beers, water for all three") |                                      | The AI reads VND 255,000 with three items and the tip; the ledger computes alice 3.09, bob 3.09, charlie 3.50                                                                               |
| 2   | alice       | Send                                                                                                                                                               | `EXPENSE_SUBMITTED`                  | Lines: bob 3.09, charlie 3.50; "Owed to you" 6.59                                                                                                                                           |
| 3   | charlie     | Within the window, Contest with the reason "I only had water"                                                                                                      | `LINE_SEEN`, `LINE_DECIDED{contest}` | "You contested this line: waiting for dave to decide."                                                                                                                                      |
| 4   | bob's agent | nothing                                                                                                                                                            | `LINE_SEEN`, `PAYMENT_MADE`          | "Paid 3.09 to alice automatically: no objection in … s, under your limit of 20.00." Proof ✓✓✓, 0 blocks mined                                                                               |
| 5   | dave        | Open the dispute: reason, the items the AI assigned to charlie, the photo hash; alice shows the photo in person; Confirm                                           | `DISPUTE_RESOLVED{upheld}`           | charlie must now approve 3.50 himself before the new deadline                                                                                                                               |
| 6   | clock       | charlie does nothing                                                                                                                                               |                                      | After the payment deadline the line shows up among dave's defaults, with the guarantee left (50.00)                                                                                         |
| 7   | dave        | Cover and exclude                                                                                                                                                  | `GUARANTEE_PAID`, `MEMBER_EXCLUDED`  | Steps shown live: "Paying 3.50 to alice with the operator's liquidity…", "Closing both channels with charlie…", then the closing txids with Esplora links. About 73 s, about 7 blocks mined |
| 8   | charlie     |                                                                                                                                                                    |                                      | "You were excluded: your channels are closed." His 50.00 come back on-chain (100.00 on-chain in total)                                                                                      |
| 9   | alice       |                                                                                                                                                                    |                                      | Reimbursed 6.59: 3.09 paid by bob, 3.50 guaranteed by the operator; her trip channel balance is 56.59                                                                                       |
| 10  | any         | Profile → Verified log (dave: the Log tab)                                                                                                                         |                                      | The browser recomputes the chain and every signature: "N events · N/N signatures valid · chain valid", same head on every phone                                                             |

Expected balances after story 2 alone: alice 56.59 spendable over Lightning; bob 46.91; charlie
0 in channels and 100.00 on-chain; dave has a 3.50 claim on charlie, and dave's agent opened no
extra liquidity (L = 30.00 is enough).

With the live timers, story 2 takes several minutes (45 s window, 120 s after dave confirms, about
73 s for cover and exclude). The plan is to run story 1 live and show story 2 on video; both stories
can run on the same trip, in that order, without `demo:reset` in between.

### Reproduce story 2 without the UI

```sh
pnpm demo:reset
pnpm e2e:demo       # irreversible: charlie ends up excluded
```

It starts its own relay and agent on ports 4400 and 4500, uses the real AI on the dinner photo and
asserts every number above, the three proof checks, at most 8 blocks for the close, the encrypted
backups on the relay, and the same log head on 4/4 agents. Log in
`infra/.out/logs/<date-time>-e2e-demo.log`, summary in `infra/.out/e2e-demo.json`. Run
`pnpm demo:reset` again before the live demo.

## Optional: bob loses his phone

With `pnpm dev` running and after bob has paid at least once:

```sh
pnpm demo:lose-phone bob
```

`infra/treasury/lose-phone.ts` records bob's node key and balance, downloads the latest encrypted
backup from the relay, stops bob's node for good (its data is kept, and `infra:up` refuses to
start it again until `demo:reset`), starts an empty node (`rln-bob-restored`, same ports and
network name), restores and unlocks it, waits for usable channels and compares: same node key,
same channels, same balance (46.91 after the dinner). A new payment from the restored node works.
Headless version: `pnpm demo:reset && pnpm e2e:lose-phone`.

## Other scenarios

| Command              | Shows                                                                                                                                                                                           |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm e2e:liquidity` | alice is owed 35.00 by bob, more than her 30.00 of inbound liquidity; dave's agent opens a 35.00 channel to her right away (about 9 s and 6 blocks on regtest), then bob's payment goes through |
| `pnpm e2e:onchain`   | bob pays alice 1.00 with an on-chain RGB transfer (`/rgbinvoice`, `/sendrgb`), proof = txid confirmed in 1 block                                                                                |

Each of them is irreversible; run `pnpm demo:reset` afterwards.
