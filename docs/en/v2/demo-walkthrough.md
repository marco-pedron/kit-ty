# v2 demo walkthrough

This is ongoing work on the v2 branch; the version presented at the final is on main.

This page replays the v2 demo step by step. Every step is a test of
[`apps/agent/src/e2e/demo-v2.e2e.ts`](https://github.com/marco-pedron/kit-ty/tree/v2/apps/agent/src/e2e/demo-v2.e2e.ts),
which drives the agents through their HTTP API, without the UI, on the real regtest stack: real
RGB Lightning nodes, real on-device AI, three real Nostr relays. The numbers below are the ones
the script asserts. The v1 demo is in [../demo-walkthrough.md](../demo-walkthrough.md).

## Run it

On a checkout of the `v2` branch, with Docker running and Node 22 (see
[getting started](../getting-started.md) for the prerequisites and the node image):

```sh
pnpm install
pnpm demo:reset        # chain from scratch, seed, channels; also wipes the relays and local copies
pnpm e2e:demo:v2       # the story below, with assertions (KITTY_REGISTRY=v2)
```

The script is irreversible: the members leave and close their channels at the end. Run
`pnpm demo:reset` again before anything else.

To click through the same story in the browser instead, start the app on the registry v2 after
the reset, with `KITTY_REGISTRY=v2 pnpm dev`, and open `?as=alice`, `?as=bob` and `?as=charlie`
on `http://127.0.0.1:5173/`. `dave`'s window only shows the LSP and its operations.

The lost-phone story is a separate script, run from a fresh reset:

```sh
pnpm demo:reset && pnpm e2e:lose-phone:v2
```

## Starting state

After `pnpm demo:reset`, each traveler has 50.00 `DUSD` in a trip channel to `dave`'s node and
30.00 of `dave`'s liquidity to receive, on Bitcoin regtest. When the agents start, `alice` creates
the trip in the registry v2 and invites `bob` and `charlie`, who join with alice's invitation. In a
real trip the invitation travels as a QR code; in the demo it is passed inside the agents'
process. `dave` is not invited: that node is only the LSP.

## The story

| #   | What happens                                                                                                                                                             | What the script checks                                                                                                                                                                       |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **Three members, no coordinator.** `alice`, `bob` and `charlie` are active members of the registry v2, each with 50.00 in their trip channel.                            | Every phone reports `registry: v2` and `coordinator: null`; three active members; `dave` has no trip and no member view                                                                      |
| 2   | **The AI reads the receipt.** `alice` uploads the photo of the dinner receipt; QVAC reads it on the device.                                                              | VND receipt, total 255,000, tip 20,000, items 130,000 / 75,000 / 30,000, no warnings                                                                                                         |
| 2   | **The sentence gives the split.** `alice` writes _"Bob e io la pho, Charlie solo birre, l'acqua in tre"_ ("Bob and I the pho, Charlie only beers, water for all three"). | The ledger's preview: alice 3.09, bob 3.09, charlie 3.50                                                                                                                                     |
| 2   | **alice submits.** alice's agent creates one invoice per debtor on alice's node, signs and encrypts `EXPENSE_SUBMITTED` and publishes it to the three relays.            | Lines: bob 3.09, charlie 3.50                                                                                                                                                                |
| 3   | **charlie contests: "I only had water".**                                                                                                                                | charlie's line is `contested`. On bob's phone the line shows `bob` as the only voter, able to vote, no outcome yet (in a group of three, the only member who is neither creditor nor debtor) |
| 4   | **A relay stops.** Relay 2 is stopped in the middle of the demo.                                                                                                         | Relay 2 does not answer; relay 1 still serves the events                                                                                                                                     |
| 5   | **bob does nothing.** After the silent-assent window, bob's agent pays 3.09 to alice through the LSP.                                                                    | bob's line `paid` by the debtor, the agent's reason mentions 3.09, the payment proof is verified, **no block mined** since the submission, bob's trip channel at 46.91                       |
| 6   | **Nobody decides for charlie.** The old coordinator route is called on `dave`.                                                                                           | It answers `NOT_ALLOWED` ("no coordinator"); charlie's line is still `contested` and was not paid automatically                                                                              |
| 7   | **charlie withdraws.** charlie sees the line again and approves it: the approval cites the contest, so it withdraws it (rule C3). charlie's agent pays 3.50.             | Line `due`, then `paid`; the reason mentions 3.50; proof verified; charlie at 46.50                                                                                                          |
| 8   | **alice is reimbursed 6.59**: 3.09 from bob and 3.50 from charlie, both paid by the debtors.                                                                             | alice's trip channel at 56.59; both credits `paid` by the debtor; nothing left owed to alice                                                                                                 |
| 9   | **The relay comes back** and gets every event it missed: the phones republish what it does not return.                                                                   | Within 60 s the three relays hold exactly the same events (more than 20)                                                                                                                     |
| 10  | **Encrypted backups.** Every traveler's agent has backed up its node to the backup relay, encrypted.                                                                     | A backup of each node, larger than 10 KB                                                                                                                                                     |
| 11  | **"Ledger verified", the same state on 3/3.** Every phone verifies the three members' checkpoints.                                                                       | `matching: 3`, `compared: 3` on each phone; hash chain valid; every signature valid; the LSP opened no extra liquidity (L = 30.00 is enough)                                                 |
| 12  | **Everyone leaves.** The three members leave at the same time; each wallet closes its own two channels with the LSP.                                                     | No warning (nobody has debts or uncollected credits); two closing txids each, confirmed on Esplora; at most 8 blocks per member                                                              |
| 13  | **The DUSD come back on-chain.**                                                                                                                                         | For each member, the on-chain balance grows by exactly what was in the trip channel; trip channel at 0                                                                                       |
| 14  | **The trip is closed** on every phone, because everyone has left. Nobody decided it.                                                                                     | `trip.status` is `closed` on 3/3 phones; all three members `left`                                                                                                                            |

Closing line of the story: nobody held anyone's money, and nobody decided for anyone else. The
member who contested withdrew on their own; each member left by closing their own channels.

Balances after step 8: alice 56.59 in the trip channel (50.00 + 6.59 received), bob 46.91,
charlie 46.50. After step 13: channels closed, and the same amounts back on-chain to each.

## The lost phone

[`lose-phone.e2e.ts`](https://github.com/marco-pedron/kit-ty/tree/v2/apps/agent/src/e2e/lose-phone.e2e.ts),
run with `KITTY_REGISTRY=v2` by `pnpm e2e:lose-phone:v2`:

1. **bob pays 3.09 to alice**, and bob's agent backs bob's node up to the backup relay, encrypted.
2. **bob loses the phone.** `infra/scripts/lose-phone.sh bob` stops the old node for good, starts
   an empty one, restores it from the latest backup and checks: same node, two usable channels,
   same balance (46.91). The new phone also has **no copy of the registry**: it derives its
   per-trip keys from the seed and finds the trip again on the Nostr relays alone.
3. **A new payment from the restored node works**: proof verified, bob at 43.82.

## What the demo does not show

- No exclusion and no vote decision: with three members, charlie's contest has a single voter,
  and the story resolves it by withdrawal instead.
- No guarantee: there is none in v2. If charlie had not paid, the debt would have stayed open and
  visible to everyone, to be paid by hand.
- The shares are not signed at the table, and the rate is the one saved on alice's phone
  (`infra/fixtures/rates.json` in the demo), not an oracle.

Those gaps, and what comes next, are in [limitations and roadmap](limitations-and-roadmap.md).
