# v2 limitations and roadmap

This is ongoing work on the v2 branch; the version presented at the final is on main.

This page lists what v2 does not do yet, as plainly as possible, and the road from here to a
mainnet pilot. The limits of v1 are in [../limitations-and-roadmap.md](../limitations-and-roadmap.md);
the ones below are specific to v2 or still shared with v1. Sources, in Italian:
[ADR-001](https://github.com/marco-pedron/kit-ty/tree/v2/docs/ADR-001-formato-eventi.md),
[conflict rules](https://github.com/marco-pedron/kit-ty/tree/v2/docs/proposte/regole-conflitto.md)
and the [migration plan](https://github.com/marco-pedron/kit-ty/tree/v2/docs/piano-migrazione-stack-a.md).

## Declared limits

### Environment (as in v1)

- **Regtest only.** No mainnet, no real funds. `DUSD`, an RGB NIA asset with precision 2, stands
  in for USD₮; the on-ramp is the seed script.
- **One laptop.** The three phones are simulated: the agents run in one process (each with only
  its own wallet and keys), and every node is a `rgb-lightning-node` in Docker, over REST. There
  is no node on the phone yet.
- **`KITTY_REGISTRY=v2` is opt-in.** The default is still `v1`, and the old registry and relay
  stay in the code until a separate change removes them. The old relay still stores the encrypted
  node backups.

### Group rules

- **No guarantee.** v1's operator guarantee has no replacement. An unpaid debt stays open,
  visible to everyone, and is paid by hand. Exclusion keeps a member out but does not pay the
  creditor back.
- **Sybil (open question D3).** Exclusion and votes count members. Someone who manages to invite
  fake members can reach a majority alone.
- **Disputes without an arbiter (open question D5).** The majority vote is provisional and lives
  in one place in the code. In a group of three there is a single voter.
- **Leaving.** A contested line counts as a known debt and blocks the exit. A member can leave
  with credits still open, but after the channels close those credits are collected outside the
  app (the app warns before confirming).
- **Clocks.** `created_at` is the author's clock. It never decides the order, but it is used for
  invitation expiry, for the silent-assent window (from the debtor's own `LINE_SEEN`: the debtor
  can only delay their own assent) and for the daily cap.
- **Exchange rate.** The rate is the last one saved on the payer's phone (a static file in the
  demo), carried in the expense. An oracle is step 5, not built yet.

### Privacy

- **The relays see metadata**: per-trip keys, the trip tag, times, number and size of events, who
  is connected when. Not the content.
- **Recovery from the seed links keys.** It asks for each key on the same connection, so a relay
  can link the keys of one person during a recovery. Spreading the requests across relays,
  connections and time is still to do.
- **No secret rotation.** A member who leaves or is excluded keeps the trip secret and can read
  later events.

### Payments and the LSP

- **The recipient must be online.** Lightning needs the payee's node to be up. There is no
  presence message or push notification yet (step 7), and the LSP does not hold payments for an
  offline recipient: the debtor's agent retries.
- **Liquidity after, not before.** The LSP does not see the expenses, so it reopens liquidity after
  a payment drains a member's inbound capacity. A reimbursement larger than what the creditor can
  receive fails until the LSP has reopened; the debtor's agent retries.
- **Punishment can burn RGB assets.** If someone broadcast an old channel state, today the honest
  peer's RGB assets would be burned in the punishment transaction instead of returned. This was
  pointed out by a mentor with RGB-Tools/rgb-lightning-node#172 and is not verified by us; the
  Utexo fork has an open issue on the same point (`rgb-lightning-node#210`). The LSP cannot take anyone's funds, but a fraud by it would
  make the honest side lose the assets. A watchtower that handles RGB is on the roadmap.
- **dave's node is not backed up automatically** (as in v1): it is the hub, and a lock-backup-unlock
  cycle on it would stop every payment.

### Not built yet

- Signing the shares at the table without internet (QR, then Bluetooth): step 6. The format
  already supports signatures at the table.
- The ephemeral request for missing events to the other members: step 7. Missing events are
  fetched from the relays only.
- The "same on N/N" checkpoint comparison is computed by every agent and checked by
  `e2e:demo:v2`, but not shown in the UI.
- Validation recomputes the state of each event's ancestors (quadratic in the number of events):
  fine for a trip, to optimise if needed.

## Roadmap

These are the milestones of the pitch, in order. For each one: where it stands today and what it
needs.

### Now: v1 presented; v2 in progress on the v2 branch

- **State:** v1 is on `main`, frozen at the tag `demo-finale-v1`. v2 has finished steps 1 to 4 of
  the migration plan: the event format, the group rules, the per-trip keys and the Nostr
  transport. Both demos pass end to end on regtest (`e2e:demo` for v1, `e2e:demo:v2` and
  `e2e:lose-phone:v2` for v2).
- **Needs:** the PR that makes `v2` the default and removes the old registry and relay.

### Month 2 — Holepunch: every traveler runs their own node, connected directly peer-to-peer. No middleman.

- **State:** not started. In the plan, Holepunch (Hypercore + Autobase) is an alternative
  transport for the registry, to try next to Nostr.
- **Needs:** an implementation of the `Transport` interface (`publish`, `subscribe`,
  `fetchMissing`, `query`) on Holepunch. The registry and the ledger do not change: they already
  verify every event whatever delivers it. The phones would then sync the registry directly with
  each other, without relays. Lightning payments still go through the LSP's channels: running each
  traveler's Lightning node on their own device is the WDK node of month 4.

### Month 3 — Shared ledger: the group's ledger syncs between devices. No single point of failure.

- **State:** already working on v2, through three Nostr relays. Every phone keeps a full copy,
  fetches missing events, republishes to a relay that comes back, and compares checkpoints.
  `e2e:demo:v2` stops a relay in the middle of the demo and the group carries on.
- **Needs:** the ephemeral requests to the other members for missing events (step 7); private
  recovery from the seed (requests spread across relays and time); rotation of the trip secret;
  a second transport (month 2) so the ledger does not depend on Nostr alone. The LSP remains a
  single hub for payments until there is more than one.

### Month 4 — Mobile app: snap the receipt, local AI splits it, your agent pays.

- **State:** not started. The flow itself works today in the web app on a laptop: the photo, the
  local AI (QVAC), the split by the ledger, the agent paying under its limits. In the plan, the
  mobile app (Expo + Bare) comes with step 8 or after.
- **Needs:**
  - the Lightning node on the phone: Tether WDK's `@utexo/wdk-rgb-lightning` instead of
    `rgb-lightning-node` in Docker (step 8). In our spikes four problems were still open: strict
    signer mode, restore from backup, force close, and access to the LSP for the latest version.
    The questions are with Utexo;
  - the agent and QVAC running inside the app;
  - signing at the table offline (step 6) and presence plus push notifications so a payment
    restarts when the recipient opens the app (step 7, an LSPS5-compatible service).

### Month 5 — Submarine swaps: top up or cash out without opening and closing channels every trip.

- **State:** not started. In the plan, Kaleidoswap behind a `Swapper` module next to the
  `Wallet`, without touching the registry or the ledger. Three uses: topping up the channel
  (on-chain → Lightning), cashing out at the end of the trip (Lightning → on-chain), and paying a
  merchant that accepts Lightning in BTC.
- **Needs:** for top-up and cash-out, the swap maker must support USD₮ on the Lightning side too
  (today only BTC); this is also what would allow a single channel per member instead of two. Paying
  a merchant in BTC already fits today's model. A spike on swaps is planned, waiting for
  Kaleidoswap's answers. The LSP's non-atomic bridges (`onchain_send`, `lightning_receive`) stay
  out: during the gap the LSP would hold the funds.

### Month 6 — Mainnet pilot: a paid pilot on mainnet with one group-tour operator.

- **State:** not started; everything runs on regtest.
- **Needs:**
  - **Utexo LSP and WDK ready:** a complete `LspProvider` on the real Utexo LSP (today `dave`'s
    node plays it on `rgb-lightning-node`), the WDK node of month 4, and the mainnet readiness of
    the RGB Lightning stack, which we were told is still several months away;
  - **a watchtower** that returns the RGB assets on punishment: today they would be burned
    (RGB-Tools/rgb-lightning-node#172, see the declared risk above), so the fix upstream comes
    first;
  - **USD₮ with 6 decimals:** the v2 event schemas already carry amounts in base units with the
    asset's decimals as a trip parameter; the rest of the code still says `cents` (about 1,100
    occurrences) and needs a mechanical rename. The real USD₮ on RGB may not be an NIA asset
    (the public LSP uses IFA): to confirm with Utexo;
  - **closing the open questions** that matter with real money: Sybil (D3), the dispute model
    (D5), and a guarantee that nobody holds, which needs answers from Utexo on locking part of a
    member's channel funds;
  - an exchange-rate oracle (step 5).

### Also on the plan

Not tied to a single milestone: the exchange-rate oracle with a signed rate (step 5), signing at
the table offline (step 6), presence and push notifications (step 7), rotation of the trip
secret, more than one hub and blinded paths so the operator does not see every payment, and a
fix of RLN `/signmessage` proposed upstream.
