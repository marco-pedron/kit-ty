# Troubleshooting

This page lists the failure modes that the team actually hit while building and running kit+ty,
with the symptom you will see and the way out. It is for anyone running the app locally, in
simulated mode or on the regtest stack. If you are lost, `pnpm demo:reset` followed by `pnpm dev`
fixes most problems on the real stack, and an empty relay database fixes most problems in
simulated mode.

## Simulated mode (`pnpm dev:fakes`)

**Red banner "The relay sent an entry this phone rejects. Your agent keeps its own copy.", no
members, empty QR, "not a member of the trip".**
The relay database still holds a previous run. The fake wallet keeps its invoices in memory, so
after a restart the agents cannot verify the old `MEMBER_JOINED` events and freeze their copy of
the log. Stop the stack and start from an empty database:

```sh
rm -f apps/relay/data/relay.sqlite*
pnpm dev:fakes
```

**The receipt read by the AI is always the same dinner.** Expected: the fake AI ignores the image
and returns the demo receipt. Use `pnpm dev` with the real models to read other receipts.

**"Cover and exclude" finishes instantly.** Expected with fakes; on the real nodes it takes about
73 s and shows each step.

## Starting the real stack

**`ERR: image settleup/rln:d4762ac missing`.** Build it once with
`./infra/scripts/build-rln.sh` (15-40 minutes).

**`ERR: port <n> is already in use`.** `infra:up` checks ports 3000-3004, 3010, 18443, 50001 and
9735-9738 before starting. Stop whatever holds the port (often another regtest stack).

**`ERR: <member> lost their phone: run pnpm demo:reset, not infra:up`.** After
`demo:lose-phone`, the lost node must never come back online with an old channel state. Only
`pnpm demo:reset` clears it.

**`fnm not found` or `infra/treasury: expected @utexo/wdk-wallet-rgb@2.0.3, found another
version`.** The seed and the treasury scripts run on Node 22 through fnm and refuse any other
version of the WDK and rgb-lib packages. Install fnm and `fnm install 22.23.3`; do not upgrade the
treasury dependencies. The pinned rgb-lib binary is for macOS on Apple silicon.

**RLN answers `403 LockedNode`.** The node is not initialized or not unlocked. On a fresh stack
run `pnpm demo:reset`; after a restart of the containers run `pnpm demo:unlock`.

**After restarting the containers, a traveler's channels are not usable.** A node did not
reconnect to dave by itself (seen with charlie). `pnpm demo:unlock` reconnects the travelers to
dave and waits until every channel is usable.

## Running `pnpm dev` on the real stack

**The agent exits with "the relay holds a trip with other timers … run `pnpm demo:reset`".** The
relay database was created with different `SILENT_ASSENT_SECONDS` or
`PAYMENT_DEADLINE_SECONDS`. Run `pnpm demo:reset`, which also deletes the relay database, or start
with the same values.

**`me.balance` is `null` / "Balance not available".** The member's node did not answer. Check
`pnpm infra:check`; unlock with `pnpm demo:unlock`.

**AI status `error`.** The models are not in the local QVAC cache (`QVAC_CACHE_DIR`, default
`~/.qvac/models`), or a file's sha256 does not match the checksum pinned by `@qvac/sdk` 0.21.0.
The agent log says which file. The rest of the app keeps working.

**The Proof panel says the proof is not found right after a payment.** The agent of the viewer
has not synced the `PAYMENT_MADE` event yet; it appears within about a second.

**`INVOICE_EXPIRED`.** The invoice of a line expired (default 3600 s). The payer's agent publishes
`INVOICE_REISSUED` with a new invoice; wait and retry.

**`TOPUP_REQUIRED`.** The trip channel cannot cover the payment. There is no top-up flow in the
demo; a second trip channel would be the way (splicing is not supported by RLN).

**`NODE_UNREACHABLE` during or right after a backup.** RLN `d4762ac` could hang if a REST request
arrived during or just after `/unlock`. The wallet now holds every request during a backup and
waits 3 s after the unlock; if a node still hangs, a 60 s timeout releases the payment queue.
Restart that node's container and run `pnpm demo:unlock`.

**A payment to a node that is backing up fails.** A node locked for its backup (about 3 s) cannot
receive; the payer's agent retries after 10 s.

**"Cover and exclude" takes more than a minute.** Expected: a Lightning payment, two cooperative
closes, about 7 blocks mined and waiting for the nodes to sweep the `DUSD` back on-chain. The UI
shows each step; do not click twice.

## Tests and e2e suites

**An `e2e:*` suite fails at the first step on a stack you already used.** Most suites are
irreversible (for example, charlie is excluded). Run `pnpm demo:reset` before each one.

**`e2e:wallet` says to run `pnpm infra:up && pnpm demo:unlock`.** It needs alice and bob unlocked
with two usable channels each.

**Where are the logs?** `infra/.out/logs/<date-time>-e2e-<name>.log`, with the relay and agent
output in `…-processes.log`; `e2e:demo` also writes `infra/.out/e2e-demo.json`.

**`ExperimentalWarning: SQLite is an experimental feature`.** Harmless: the relay uses the
`node:sqlite` module built into Node 22.
