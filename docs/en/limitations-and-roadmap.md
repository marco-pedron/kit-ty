# Limitations and roadmap

This page lists, as plainly as possible, what kit+ty does not do today and what is planned. It is
for judges who want to know where the claims stop, and for contributors who want to know what is
left to build. Everything listed under "Implemented" in the other pages runs on Bitcoin regtest;
this page is about the rest.

## Environment

- **Regtest only.** No mainnet, no testnet, no real funds. `DUSD` is a demo NIA asset with
  precision 2 standing in for USD₮; the "on-ramp" is the seed script sending 100.00 `DUSD`
  on-chain to each traveler.
- **One laptop.** Four RLN nodes run in Docker and four agents run in one Node process (to load
  the AI models once). Each agent receives only its own member's wallet, but they share a machine.
  In production, the agent and the node would run on each traveler's phone.
- **Local relay**, one trip per relay database.
- **The seed and treasury scripts are pinned to macOS on Apple silicon** (`@utexo/rgb-lib` binary)
  and need Node 22 through fnm; `ai:eval:offline` uses macOS `sandbox-exec`. CI runs only
  typecheck, lint and unit tests on Linux.
- **The AI models are read from the local QVAC cache**; there is no step in the repo that
  downloads them.
- **Simulated mode** (`KITTY_FAKES=1`) has no RGB at all: fake wallet, fake AI that always returns
  the same dinner, relay validation limited to the hash chain. It is for UI development, shows a
  banner, and the demo scripts refuse it.

## Not implemented, or partially

| Area                                    | State                                                                                                                                                                             |
| --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `TRIP_CLOSED`                           | the event type and its validation exist; no flow or route publishes it, so there is no end-of-trip step                                                                           |
| Cross-phone checkpoint comparison       | agents publish `CHECKPOINT` every 10 events and `e2e:demo` checks that the heads match, but the UI does not show "same on N/N phones" (`ledger.checkpoints` is `null`)            |
| Paying an excluded member               | the on-chain RGB rail (`OnchainRail`) works and is tested (`e2e:onchain`), but no event carries an on-chain invoice yet, so the flows cannot pay a member who has no channels     |
| Paying an overdue line by hand          | the agent's sentence suggests it, but there is no API route; an overdue line is covered by the guarantee or stays open                                                            |
| Manual expense form after an AI failure | the AI returns the partial result, but the UI asks to retake the photo instead of opening a pre-filled form; rows of a successful extraction are editable                         |
| Receipt date within the trip            | not checked; the deterministic checks are on totals, subtotal and line arithmetic                                                                                                 |
| Top-up                                  | the low-balance warning exists (`topupWarning`), not the top-up itself; RLN has no splicing, so it would be a second trip channel                                                 |
| Backups of dave's node                  | not automatic (RLN `d4762ac` sometimes hung after a lock/unlock cycle, and dave is the hub); travelers are backed up                                                              |
| Backup upload authentication            | the relay accepts any upload for a pubkey; in production the upload should be signed with the app key                                                                             |
| Agent API authentication                | none: it listens on `127.0.0.1` and the actor is a path segment                                                                                                                   |
| Encrypted photo sharing in a dispute    | the payer shows the photo in person; only its hash is in the log                                                                                                                  |
| `ln-lsp` and `onchain` rail modes       | exist in the configuration type; the demo and tests use `ln-2ch`                                                                                                                  |
| Liquidity after an agent restart        | the extra liquidity dave opened is remembered in memory; after a restart the agent may open once more (capital locked, never funds at risk)                                       |
| Guarantee above G                       | a line above the guarantee left is not covered; the creditor keeps an off-chain claim on the debtor                                                                               |
| Stale-backup window                     | a node is backed up about 10 s after it goes quiet after a change; a loss inside that window would restore an older state (the safe alternative is a cooperative close with dave) |

## Why not WDK for the Lightning nodes (yet)

The team tried Tether WDK's `@utexo/wdk-rgb-lightning` (`0.1.0-beta.15`) as every member's node,
in-process, with VSS backups (`docs/spike-wdk.md`). It ran four nodes and routed RGB payments, but
the signer state did not survive a restart (closes blocked, a node that could no longer be
unlocked), a cooperative close did not sweep the `DUSD` back on-chain, VSS restore hung at unlock,
and routing worked only in the `ln-lsp` shape. The upstream fixes were not published on npm. The
demo therefore uses `rgb-lightning-node` over REST for every node and WDK's
`@utexo/wdk-wallet-rgb` 2.0.3 for dave's on-chain treasury (issuance and on-ramp).

## Roadmap

- **Native mobile app.** The agent and the node on each traveler's phone, so that "only you can
  spend it" holds physically too. Candidate paths: `@utexo/rgb-sdk-rn`, or the WDK module on Bare.
- **WDK Lightning node per member**, in-process and on mobile, with VSS backups, once the upstream
  fixes (persistent signer, sweep after close, VSS restore) are released.
- **Checkpoints outside the relay** (for example over Lightning onion messages) and the cross-phone
  comparison in the UI.
- **Watchtower** independent of the operator, against an old channel state being broadcast.
- **More than one hub and blinded paths**, so the operator does not see every payment.
- **Unlock or biometrics** for approvals above the limit; Biscuit tokens on the node APIs.
- **The production timers**: hours for the contest window and a day for the payment deadline,
  instead of the 45 s / 120 s of the live demo.
- A fix of RLN `/signmessage` (it signs the empty string at `d4762ac`), proposed upstream, so the
  node key could sign events directly.
