# API reference

This page is the reference for developers who integrate with or extend kit+ty: the relay's HTTP
and SSE endpoints, the agent's HTTP API used by the UI, the event types and their fields, the
error format, the public functions of the ledger, and the internal interfaces of the agent. It is
derived from the zod schemas and route definitions; when in doubt, those files are authoritative:
`packages/shared/src/{events,api,views,domain,errors}.ts`, `apps/relay/src/server.ts`,
`packages/ledger/src/index.ts`.

## Conventions

- **Amounts** are `bigint` in TypeScript and **decimal strings of minor units on the wire**
  (`"309"` = 3.09 `DUSD`; for receipts, minor units of the receipt currency, VND exponent 0).
  `DUSD` has precision 2, so 1 cent = 1 asset unit. Floats are never used for money.
- Hashes, payment hashes, preimages, txids and app pubkeys are 32 bytes of **lowercase hex**;
  node pubkeys are compressed secp256k1 (`02…`/`03…`, 33 bytes hex); nonces are 16 bytes hex.
- Trip and expense ids match `^[A-Za-z0-9_-]{1,64}$` (they travel inside invoice descriptions
  `kitty:<tripId>:<expenseId>:<debtor>`).
- Member ids are `alice`, `bob`, `charlie`; the coordinator is `dave`.
- Every error is a non-2xx response with body:

```json
{ "error": { "code": "TOPUP_REQUIRED", "message": "…", "action": "Your trip channel is too low to pay this. Top up your channel, then retry." } }
```

`action` is always one human next step. Codes are listed in [Error codes](#error-codes).

## Relay (`apps/relay`, default `http://127.0.0.1:4000`)

One relay database holds one trip and one hash chain. The relay holds no private key.

| Method and path | Request | Success | Errors |
| --- | --- | --- | --- |
| `GET /health` | | `200 { "ok": true, "service": "relay" }` | |
| `POST /events` | JSON `SignedEvent` | `201` the `StoredEvent` | `400 VALIDATION_ERROR` (not a signed event); `409 INVALID_EVENT` (another trip, nonce reused, or rejected by `validateEvent`, with the reason) |
| `GET /events?since=<seq>` | `since` ≥ 0, default 0 | `200` array of `StoredEvent` with `seq > since`, in order | `400 VALIDATION_ERROR` (bad `since`) |
| `GET /events/stream?since=<seq>` | `since`, or the `Last-Event-ID` header on reconnect | `200 text/event-stream`: first the backlog, then every new event | `400 VALIDATION_ERROR` |
| `PUT /backups/:pubkey` | `application/octet-stream`, non-empty, ≤ 2 MiB | `201 { "version": <n> }` | `400` bad pubkey or empty body; `413` too large |
| `GET /backups/:pubkey` | | `200 application/octet-stream`, the latest version, with headers `x-backup-version` and `x-backup-created-at` | `400` bad pubkey; `404 NOT_FOUND` |

SSE message format (`apps/relay/src/sse.ts`): each event is sent as

```text
id: <seq>
event: stored
data: <StoredEvent JSON>

```

with a `: connected` comment after the backlog and a `: heartbeat` comment every 15 s. Append is
synchronous, so no event can be lost between the backlog and the live stream.

Backups are append-only: a `PUT` adds a version, it never overwrites. Uploads are not
authenticated (see [security-model.md](security-model.md#backups)).

## Event types

Envelope: `SignedEvent = { inner, sig }`, `inner = { v: 1, tripId, type, author, nonce, createdAt,
body }`; the relay wraps it as `StoredEvent = { seq, prevHash, signed, receivedAt, hash }` with
`hash = sha256(canonical({ seq, prevHash, signed }))`. `sig` is ed25519 over the canonical JSON
(RFC 8785) of `inner`. Pubkeys in bodies that name a member (`debtorPubkey`, `creditorPubkey`,
`memberPubkey`, `coordinatorPubkey`) are author keys (the ed25519 `appPubkey`), never node keys.

| Type | Author | Body |
| --- | --- | --- |
| `TRIP_CREATED` | coordinator | `name`, `assetId` (RGB asset id of `DUSD`), `params: TripParams`, `coordinatorPubkey` |
| `RATE_SET` | coordinator | `asOf` (date), `source`, `rates` (currency → units per 1 USD, decimal strings) |
| `MEMBER_JOINED` | member | `displayName`, `memberId`, `appPubkey`, `nodePubkey`, `bindInvoice` (BOLT11 from the member's node, description `kitty-bind:<sha256(appPubkey)>`), `policy` |
| `MEMBER_ADMITTED` | coordinator | `memberPubkey` |
| `POLICY_UPDATED` | member | `policy` |
| `CHANNELS_READY` | coordinator | `memberPubkey`, `tripChannelId`, `liquidityChannelId` |
| `EXPENSE_SUBMITTED` | payer | `expenseId`, `receipt`, `receiptImageSha256`, `rateEventHash`, `rate`, `totalUsdCents`, `payerCents`, `payerItemIndexes`, `lines: [{ debtorPubkey, cents, itemIndexes, bolt11 }]`, `fingerprint` |
| `LINE_SEEN` | debtor | `expenseEventHash` |
| `LINE_DECIDED` | debtor | `expenseEventHash`, `decision: approve \| contest`, `cents`, `reason?` (required to contest) |
| `PAYMENT_MADE` | debtor | `expenseEventHash`, `creditorPubkey`, `cents`, and either `rail: ln` + `paymentHash` + `preimage`, or `rail: onchain` + `txid` |
| `EXPENSE_VOIDED` | payer | `expenseEventHash` (only if no line is paid or guaranteed) |
| `DISPUTE_RESOLVED` | coordinator | `expenseEventHash`, `debtorPubkey`, `outcome: upheld \| line_voided \| expense_voided`, `note` |
| `INVOICE_REISSUED` | payer | `expenseEventHash`, `debtorPubkey`, `bolt11` (only after the previous one expired) |
| `GUARANTEE_PAID` | coordinator | `expenseEventHash`, `debtorPubkey`, `creditorPubkey`, `cents`, `paymentHash`, `preimage` |
| `MEMBER_EXCLUDED` | coordinator | `memberPubkey`, `reason`, `closingTxids` |
| `CHECKPOINT` | any member | `seq`, `headHash` |
| `TRIP_CLOSED` | coordinator | `summary` (defined and validated; no flow publishes it yet) |

Main body types (`packages/shared/src/domain.ts`):

```ts
type Receipt = {
  merchant: string; date: string /* YYYY-MM-DD */; currency: CurrencyCode;
  items: { label: string; quantity: number /* integer */; unitPrice: bigint; total: bigint }[];
  subtotal?: bigint; tax?: bigint; tip?: bigint; total: bigint; warnings: string[];
};
type Policy = { autoPayLimitCents: bigint; dailyCapCents: bigint; payUpheldDisputes: boolean };
type TripParams = {
  railMode: 'ln-2ch' | 'ln-lsp' | 'onchain'; tripChannelCents: bigint; liquidityCents: bigint;
  guaranteeCapCents: bigint; channelCapacitySat: bigint; silentAssentSeconds: number;
  paymentDeadlineSeconds: number; invoiceExpirySeconds: number; topupWarnPercent: number;
};
type SplitProposal = {
  assignments: { itemIndex: number; members: MemberId[] }[];
  unassigned: number[]; clarificationNeeded?: string;
};
type AiResult<T, P = Partial<T>> =
  | { ok: true; data: T; attempts: number; latencyMs: number }
  | { ok: false; partial: P; error: string; attempts: number; latencyMs: number };
```

`fingerprint = sha256(canonical({ merchant, date, currency, total, receiptImageSha256 }))`.

## Agent HTTP API (`apps/agent`, default `http://127.0.0.1:4100`)

Defined once in `packages/shared/src/api.ts` (`routes`) and used both by the server
(`apps/agent/src/routes/index.ts`) and by the typed client `createAgentClient(baseUrl, as)` in
`packages/shared/src/client.ts`. The actor is in the path (`:as` is `alice`, `bob`, `charlie` or
`dave`); a traveler calling a coordinator route, or the reverse, gets `403 NOT_ALLOWED`. The API
has no authentication: it listens on `127.0.0.1` for the demo laptop only.

| Method and path | Roles | Body | Response |
| --- | --- | --- | --- |
| `GET /health` | | | `{ ok: true, service: "agent", fakes }` |
| `GET /api/:as/state` | both | | `TripView` |
| `POST /api/:as/expenses/extract` | traveler | `{ image: { mimeType: image/jpeg \| image/png \| image/webp, dataBase64 } }` | `AiResult<Receipt>` |
| `POST /api/:as/expenses/split` | traveler | `{ receipt, text, clarification?: { question, answer } }` | `{ result: AiResult<SplitProposal>, preview: { rate, rateAsOf, totalUsdCents, shares: [{ member, cents }] } \| null }` |
| `POST /api/:as/expenses` | traveler (the payer) | `{ receipt, assignments, receiptImageSha256 }` | `ExpenseView` |
| `POST /api/:as/expenses/:id/decision` | traveler (the debtor) | `{ decision: approve \| contest, reason? }` (a contest needs a reason) | `LineView` |
| `POST /api/:as/expenses/:id/void` | traveler (the payer) | | `ExpenseView` |
| `PUT /api/:as/policy` | traveler | `{ policy }` (the whole policy) | `Policy` |
| `POST /api/dave/disputes/:expenseId/:member` | coordinator | `{ outcome: upheld \| line_voided \| expense_voided, note }` | `LineView` |
| `POST /api/dave/defaults/:expenseId/:member/cover-and-exclude` | coordinator | | `{ covered: ProofRef \| null, closingTxids }` (about 73 s on regtest) |
| `PUT /api/dave/rates` | coordinator | `{ asOf, source, rates }` | the same `RateView` |
| `GET /api/proof/:paymentHash` | both | `:paymentHash` = payment hash, or txid for on-chain | `ProofView` |

HTTP status by error code: `400` validation and ledger rules (`VALIDATION_ERROR`,
`TOTAL_MISMATCH`, …), `403 NOT_ALLOWED`, `404 NOT_FOUND`, `409` (`INVALID_EVENT`,
`TOPUP_REQUIRED`, `INVOICE_EXPIRED`, `INSUFFICIENT_ALLOCATIONS`), `501 NOT_IMPLEMENTED`,
`502 PAYMENT_FAILED`, `503` (`AI_NOT_READY`, `AGENT_NOT_READY`, `RELAY_UNREACHABLE`,
`NODE_UNREACHABLE`, `RECEIVER_UNREACHABLE`, `NO_AVAILABLE_UTXOS`), `500 INTERNAL`.

### `TripView` (`GET /api/:as/state`)

Top-level fields (`packages/shared/src/views.ts`):

| Field | Content |
| --- | --- |
| `as`, `role`, `fakes`, `serverNow` | who is asking; `fakes` = show the banner; server clock for countdowns |
| `trip` | `{ tripId, name, assetId, status: open \| closed, params }`, or `null` before `TRIP_CREATED` |
| `rate` | the current `RATE_SET` (`asOf`, `source`, `rates`) or `null` |
| `members` | `memberId`, `displayName`, `pubkey`, `nodePubkey`, `status: joined \| admitted \| active \| excluded`, `closingTxids` |
| `me` | travelers only: `policy`, `balance` (`tripOutboundCents`, `inboundCents`, `onchainCents`, `tripChannelCents`, `topupWarning`, or `null` if the node does not answer), `oweCents`, `owedToMeCents`, `autoPaidTodayCents`, `debts`, `credits` (`LineView[]`) |
| `coordinator` | dave only: per-member guarantee used and left, operator credit, liquidity margin; `disputes`; `defaults` (with `guaranteeLeftCents`, `coverable`) |
| `expenses` | `ExpenseView[]`: receipt data, rate, items with assigned members, `lines`, `status: open \| settled \| voided`, `warnings` |
| `activity` | log events and the agent's own decisions, with proof refs |
| `operations` | long-running work in progress (`paying`, `covering`, `closing_channels`, `opening_liquidity`, `backing_up`, …) with text and timings |
| `ai` | `{ status: loading \| ready \| error, error?, fake }` |
| `ledger` | `events`, `validSignatures`, `chainValid`, `headSeq`, `headHash`, `checkpoints` (currently always `null`) |
| `explorerBaseUrl` | Esplora base for `/tx/<txid>` links |

A traveler never receives `coordinator`, and `me` is always their own (enforced by a
`superRefine` on the schema).

`LineView` carries `expenseId`, `payer`, `debtor`, `cents`, `state`, `seenAt`, `deadlineAt`,
`contestReason`, `resolution`, `agent: { pay, reason }` (the `decideAutoPay` sentence), `paidBy:
debtor | guarantee`, `proof`, `invoiceExpiresAt`.

### `ProofView` (`GET /api/proof/:paymentHash`)

For Lightning: `paymentHash`, `preimage`, `cents`, `payeePubkey`, `expenseId`, `creditor`,
`debtor`, `paidBy`, `checks: { preimageMatchesHash, invoiceSignedByCreditor, amountMatches }`
(each `{ ok, label, detail }`) and `verified`. For on-chain: `txid`, `explorerUrl`, `cents` and
the checks that the transaction is on the explorer and the amount matches. A proof can be `404`
for about a second right after a payment, until the agent has synced the event.

## Error codes

`ErrorCodeSchema` in `packages/shared/src/errors.ts`, each with a default `action`
(`ERROR_ACTIONS`):

| Group | Codes |
| --- | --- |
| Ledger rules | `UNKNOWN_CURRENCY`, `MISSING_RATE`, `INVALID_RATE`, `INVALID_RATE_TABLE`, `TOTAL_MISMATCH`, `UNKNOWN_PARTICIPANT`, `DUPLICATE_PARTICIPANT`, `INVALID_ASSIGNMENT`, `NEGATIVE_AMOUNT`, `EMPTY_ALLOCATION`, `INVALID_EVENT`, `NOT_IMPLEMENTED` |
| Agent and API | `TOPUP_REQUIRED`, `AI_NOT_READY`, `AGENT_NOT_READY`, `NOT_ALLOWED`, `NOT_FOUND`, `VALIDATION_ERROR`, `RELAY_UNREACHABLE`, `INTERNAL` |
| Lightning and RGB nodes | `NODE_UNREACHABLE`, `INVOICE_EXPIRED`, `PAYMENT_FAILED`, `RECEIVER_UNREACHABLE`, `INSUFFICIENT_ALLOCATIONS`, `NO_AVAILABLE_UTXOS` |

## Ledger (`@kitty/ledger`)

Pure functions, no I/O (`packages/ledger/src/index.ts`). The main ones:

| Function | Signature (simplified) | Purpose |
| --- | --- | --- |
| `deriveTrip` | `(events: StoredEvent[], now: Date) => TripState \| null` | Replays the log: members, policies, expenses, every line's state and deadlines, owed and owed-to-me per member, guarantee used, defaults, nonces and fingerprints seen, head. `null` for an empty log. |
| `validateEvent` | `(stored: StoredEvent, trip: TripState \| null, deps: ValidationDeps) => { ok: true } \| { ok: false, code: 'INVALID_EVENT', reason }` | Every rule of the log; never throws. `ValidationDeps = { verify: SignatureVerifier, decodeInvoice: (bolt11) => DecodedInvoice }`. |
| `decideAutoPay` | `(policy, line: LineRecord, trip: TripState, now: Date, invoice: DecodedInvoice \| null) => { pay: boolean, reason: string }` | Whether the debtor's agent pays now, and the sentence shown to the user. |
| `autoPaidLast24h` | `(trip, debtorPubkey, now) => bigint` | Rolling 24 h total of automatic payments. |
| `liquidityPlan` | `(trip, thresholdCents, extraLiquidity?) => LiquidityNeed[]` | Per active member with channels: `inboundCents`, `toReceiveCents`, `marginCents` and `openCents` (= threshold − margin when the margin is below the threshold, else 0). |
| `expenseShares` | `(input: ShareInput) => ShareResult` | Shares in USD cents from a receipt, item assignments and a rate; also used by the browser for previews. |
| `expenseFingerprint` | `(receipt, receiptImageSha256) => string` | The duplicate-receipt fingerprint. |
| `convertToUsdCents`, `lockRate`, `parseRateTable`, `manualRate` | | Exact FX with rational rates. |
| `allocateByWeight`, `splitEqually` | | Integer allocation with largest-remainder rounding. |
| `lineKey` | `(expenseEventHash, debtorPubkey) => string` | Key of a line in `TripState.lines`. |

## Agent interfaces

Defined in `apps/agent/src`; an agent receives only its own member's instances.

```ts
interface Wallet {                                   // wallet/types.ts
  readonly engine: 'wdk' | 'rln-rest';               // 'rln-rest' in the demo
  nodePubkey(): Promise<string>;
  authorPubkey(): Promise<string>;                   // ed25519 appPubkey
  sign(message: string): Promise<string>;            // ed25519, never RLN /signmessage
  bindInvoice(appPubkey: string): Promise<string | null>;
  createInvoice(p: { cents: bigint; description: string; expirySec: number }):
    Promise<{ bolt11: string; paymentHash: string }>;
  decodeInvoice(bolt11: string): Promise<DecodedInvoice>;
  pay(bolt11: string, opts?: { timeoutMs?: number }): Promise<PaymentProof>;
  balances(): Promise<{ tripOutboundCents: bigint; inboundCents: bigint; onchainCents: bigint }>;
  openLiquidity(peerPubkey: string, cents: bigint): Promise<{ channelId: string }>; // dave only
  closeChannelsWith(peerPubkey: string): Promise<{ txids: string[] }>;           // dave only
  backupNow(): Promise<{ version: string; blob: Uint8Array }>;   // lock → backup → unlock
}

interface Rail {                                     // rail/types.ts
  readonly mode: 'ln-2ch' | 'ln-lsp' | 'onchain';
  requestPayment(p: { cents: bigint; description: string; expirySec: number }): Promise<PaymentRequest>;
  pay(req: PaymentRequest): Promise<PaymentProof>;
}

interface AiService {                                // ai/types.ts
  status(): 'loading' | 'ready' | 'error';
  extractReceipt(image: Uint8Array): Promise<AiResult<Receipt>>;
  proposeSplit(receipt: Receipt, members: MemberId[], text: string,
    clarification?: { question: string; answer: string }, payer?: MemberId):
    Promise<AiResult<SplitProposal>>;
}

interface RelayClient {                              // relay/types.ts
  append(e: SignedEvent): Promise<StoredEvent>;
  list(sinceSeq?: number): Promise<StoredEvent[]>;
  subscribe(onEvent: (e: StoredEvent) => void,
    opts?: { sinceSeq?: number; onStatus?: (s: RelayStatus) => void }): () => void;
  putBackup(pubkey: string, blob: Uint8Array): Promise<void>;
  getBackup(pubkey: string): Promise<Uint8Array | null>;
}

interface SignatureVerifier {                        // packages/shared/src/crypto.ts
  verify(authorPubkey: string, message: string, signature: string): boolean;
}
```

`LightningRail` (`rail/lightning-rail.ts`) is the rail used in the demo; `OnchainRail`
(`rail/onchain-rail.ts`, RGB `/rgbinvoice` + `/sendrgb`, proof = txid) is implemented and tested
by `pnpm e2e:onchain` but not used by the flows yet.

The RLN REST API itself is described by `docs/vendor/rln-openapi.yaml` and wrapped by
`createRlnClient(baseUrl)` in `@kitty/rln-client`.
