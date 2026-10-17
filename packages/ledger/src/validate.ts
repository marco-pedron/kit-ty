import {
  EVENT_AUTHOR,
  FINAL_LINE_STATES,
  GENESIS_HASH,
  sha256Hex,
  signingMessage,
  storedEventHash,
  type DecodedInvoice,
  type EventInner,
  type EventInnerOf,
  type EventType,
  type StoredEvent,
} from '@kitty/shared';
import { hexToBytes } from './hex.js';
import type {
  LineRecord,
  MemberState,
  TripState,
  ValidationDeps,
  ValidationResult,
} from './kitty.js';
import { lineKey } from './kitty.js';
import { expenseFingerprint, expenseShares } from './shares.js';

// validateEvent (task A2, SPEC §9.3): the same rules on the relay (which rejects the event)
// and in every agent (which trusts no relay). Pure: signatures and invoice decoding injected.

class Invalid extends Error {}

/** Throws the rejection reason; caught once in validateEvent. */
function ensure(condition: boolean, reason: string): asserts condition {
  if (!condition) throw new Invalid(reason);
}

const isFinal = (l: LineRecord) => FINAL_LINE_STATES.includes(l.state);

/**
 * Checks one event against the trip derived from all the previous ones. Call it with
 * `trip = deriveTrip(previous, new Date(stored.receivedAt))`, so line states are those at
 * reception; `trip` is null before TRIP_CREATED. The shape is assumed already parsed with
 * StoredEventSchema. Never throws: a decoder or ledger error is a rejection with its reason.
 */
export function validateEvent(
  stored: StoredEvent,
  trip: TripState | null,
  deps: ValidationDeps,
): ValidationResult {
  try {
    check(stored, trip, deps);
    return { ok: true };
  } catch (err) {
    const reason = err instanceof Invalid ? err.message : `rule check failed: ${String(err)}`;
    return { ok: false, code: 'INVALID_EVENT', reason };
  }
}

function check(stored: StoredEvent, trip: TripState | null, deps: ValidationDeps): void {
  const { inner, sig } = stored.signed;

  // Chain (SPEC §9.4): reordering or omission is evident.
  const expectedSeq = (trip?.head?.seq ?? 0) + 1;
  ensure(stored.seq === expectedSeq, `seq ${stored.seq}, expected ${expectedSeq}`);
  ensure(
    stored.prevHash === (trip?.head?.hash ?? GENESIS_HASH),
    'prevHash is not the hash of the previous event',
  );
  ensure(stored.hash === storedEventHash(stored), 'hash does not match the event');

  ensure(deps.verify.verify(inner.author, signingMessage(inner), sig), 'invalid signature');

  if (trip === null) {
    ensure(inner.type === 'TRIP_CREATED', 'the first event must be TRIP_CREATED');
    ensure(
      inner.author === inner.body.coordinatorPubkey,
      'TRIP_CREATED must be signed by the coordinator it names',
    );
    return;
  }
  ensure(inner.type !== 'TRIP_CREATED', 'the trip already exists');
  ensure(inner.tripId === trip.tripId, `event for trip ${inner.tripId}, not ${trip.tripId}`);
  ensure(!trip.noncesSeen.has(inner.nonce), 'nonce already used in this trip (replay)');
  ensure(!trip.closed || inner.type === 'CHECKPOINT', 'the trip is closed');

  const isDave = inner.author === trip.coordinatorPubkey;
  const role = EVENT_AUTHOR[inner.type];
  if (role === 'coordinator') {
    ensure(isDave, `${inner.type} can only be signed by the coordinator`);
  } else if (role !== 'any') {
    ensure(!isDave, `${inner.type} cannot be signed by the coordinator`);
  }
  if (inner.type !== 'MEMBER_JOINED' && !isDave) {
    ensure(trip.members.get(inner.author)?.admitted === true, 'author not admitted to the trip');
  }

  const ctx: Ctx = { trip, deps, at: Date.parse(stored.receivedAt) };
  const rule = rules[inner.type] as (inner: EventInner, ctx: Ctx) => void;
  rule(inner, ctx);
}

interface Ctx {
  trip: TripState;
  deps: ValidationDeps;
  /** receivedAt, in ms. */
  at: number;
}

type Rules = { [T in EventType]: (inner: EventInnerOf<T>, ctx: Ctx) => void };

function member(trip: TripState, pubkey: string): MemberState {
  const m = trip.members.get(pubkey);
  ensure(m !== undefined, `${pubkey.slice(0, 8)}… is not a member`);
  return m;
}

function activeMember(trip: TripState, pubkey: string): MemberState {
  const m = member(trip, pubkey);
  ensure(m.admitted, `${m.memberId} is not admitted`);
  ensure(!m.excluded, `${m.memberId} is excluded`);
  return m;
}

function lineOf(trip: TripState, expenseEventHash: string, debtor: string): LineRecord {
  const expense = trip.expenses.get(expenseEventHash);
  ensure(expense !== undefined, 'unknown expense');
  const line = trip.lines.get(lineKey(expenseEventHash, debtor));
  ensure(line !== undefined, 'not a debtor of this expense');
  return line;
}

function decode(deps: ValidationDeps, bolt11: string): DecodedInvoice {
  try {
    return deps.decodeInvoice(bolt11);
  } catch (err) {
    throw new Invalid(`invoice not decodable: ${String(err)}`);
  }
}

/** The invoice of a line: payable to the payer's node, trip asset, line amount (SPEC §9.3). */
function checkLineInvoice(
  ctx: Ctx,
  bolt11: string,
  expected: { payer: MemberState; debtor: MemberState; expenseId: string; cents: bigint },
): DecodedInvoice {
  const inv = decode(ctx.deps, bolt11);
  const who = expected.debtor.memberId;
  ensure(
    inv.payeePubkey === expected.payer.nodePubkey,
    `invoice for ${who} is payable to another node`,
  );
  ensure(inv.assetId === ctx.trip.assetId, `invoice for ${who} is not for the trip asset`);
  ensure(inv.cents === expected.cents, `invoice for ${who} is not for ${expected.cents} cents`);
  ensure(
    inv.description === `kitty:${ctx.trip.tripId}:${expected.expenseId}:${who}`,
    `invoice for ${who} has the wrong description`,
  );
  ensure(Date.parse(inv.expiresAt) > ctx.at, `invoice for ${who} has already expired`);
  return inv;
}

/** sha256(preimage bytes) = the payment hash of the line invoice (SPEC §10.2). */
function checkPreimage(ctx: Ctx, line: LineRecord, paymentHash: string, preimage: string): void {
  const inv = decode(ctx.deps, line.bolt11);
  ensure(paymentHash === inv.paymentHash, 'paymentHash is not the one of the line invoice');
  ensure(sha256Hex(hexToBytes(preimage)) === paymentHash, 'preimage does not match paymentHash');
}

const rules: Rules = {
  TRIP_CREATED: () => undefined, // handled before: only as the first event
  RATE_SET: () => undefined,

  MEMBER_JOINED: (inner, { trip, deps }) => {
    const b = inner.body;
    ensure(inner.author === b.appPubkey, 'MEMBER_JOINED must be signed by its appPubkey');
    ensure(!trip.members.has(inner.author), 'already joined');
    const others = [...trip.members.values()];
    ensure(!others.some((m) => m.memberId === b.memberId), `${b.memberId} has already joined`);
    ensure(!others.some((m) => m.nodePubkey === b.nodePubkey), 'node already bound to a member');
    ensure(b.bindInvoice !== null, 'a bind invoice is required (rln-rest, SPEC §9.1)');
    const inv = decode(deps, b.bindInvoice);
    ensure(inv.payeePubkey === b.nodePubkey, 'bind invoice is from another node');
    ensure(
      inv.description === `kitty-bind:${sha256Hex(b.appPubkey)}`,
      'bind invoice does not commit to the appPubkey',
    );
  },

  MEMBER_ADMITTED: (inner, { trip }) => {
    ensure(!member(trip, inner.body.memberPubkey).admitted, 'already admitted');
  },

  POLICY_UPDATED: () => undefined,

  CHANNELS_READY: (inner, { trip }) => {
    activeMember(trip, inner.body.memberPubkey);
  },

  EXPENSE_SUBMITTED: (inner, ctx) => {
    const { trip } = ctx;
    const b = inner.body;
    const { receipt } = b;
    const payer = activeMember(trip, inner.author);
    ensure(
      ![...trip.expenses.values()].some((e) => e.body.expenseId === b.expenseId),
      `expense id ${b.expenseId} already used`,
    );

    // Rate: the latest RATE_SET, locked at submission (SPEC §6.3, §13 #10).
    ensure(
      trip.rate !== null && b.rateEventHash === trip.rate.eventHash,
      'rate is not the latest RATE_SET',
    );
    const rate = receipt.currency === 'USD' ? '1' : trip.rate.body.rates[receipt.currency];
    ensure(rate !== undefined, `no ${receipt.currency} rate in the RATE_SET`);
    ensure(b.rate === rate, `rate ${b.rate} is not the RATE_SET rate ${rate}`);

    // Receipt totals, in the receipt currency.
    const itemsSum = receipt.items.reduce((a, it) => a + it.total, 0n);
    ensure(
      receipt.subtotal === undefined || receipt.subtotal === itemsSum,
      'subtotal is not the sum of the items',
    );
    ensure(
      itemsSum + (receipt.tax ?? 0n) + (receipt.tip ?? 0n) === receipt.total,
      'receipt total is not items + tax + tip',
    );

    // Debtors: distinct active members, never the payer or the coordinator.
    const debtors = b.lines.map((l) => {
      ensure(l.debtorPubkey !== inner.author, 'the payer cannot be a debtor');
      ensure(l.debtorPubkey !== trip.coordinatorPubkey, 'the coordinator cannot be a debtor');
      return activeMember(trip, l.debtorPubkey);
    });
    ensure(
      new Set(b.lines.map((l) => l.debtorPubkey)).size === b.lines.length,
      'a debtor appears twice',
    );

    // USD shares recomputed by the ledger (SPEC §11: the LLM never computes money).
    const shares = expenseShares({
      receipt,
      rate: b.rate,
      payer: inner.author,
      payerItemIndexes: b.payerItemIndexes,
      debtors: b.lines.map((l) => ({ id: l.debtorPubkey, itemIndexes: l.itemIndexes })),
    });
    const linesSum = b.lines.reduce((a, l) => a + l.cents, 0n);
    ensure(linesSum + b.payerCents === b.totalUsdCents, 'Σ lines + payerCents ≠ totalUsdCents');
    ensure(b.totalUsdCents === shares.totalUsdCents, 'totalUsdCents is not the converted total');
    ensure(b.payerCents === shares.payerCents, 'payerCents is not the recomputed share');
    b.lines.forEach((l, i) => {
      ensure(
        l.cents === shares.debtors[i]?.cents,
        `share of ${debtors[i]?.memberId} is not the recomputed one`,
      );
    });

    ensure(
      b.fingerprint === expenseFingerprint(receipt, b.receiptImageSha256),
      'fingerprint does not match the receipt',
    );
    ensure(!trip.fingerprints.has(b.fingerprint), 'duplicate receipt (same fingerprint)');

    const hashes = b.lines.map((l, i) => {
      const debtor = debtors[i];
      ensure(debtor !== undefined, 'missing debtor');
      return checkLineInvoice(ctx, l.bolt11, {
        payer,
        debtor,
        expenseId: b.expenseId,
        cents: l.cents,
      }).paymentHash;
    });
    ensure(new Set(hashes).size === hashes.length, 'two lines share one invoice');
  },

  LINE_SEEN: (inner, { trip }) => {
    const line = lineOf(trip, inner.body.expenseEventHash, inner.author);
    ensure(line.state === 'submitted', 'line already seen');
  },

  LINE_DECIDED: (inner, { trip }) => {
    const b = inner.body;
    const line = lineOf(trip, b.expenseEventHash, inner.author);
    ensure(b.cents === line.cents, `cents ${b.cents} are not the line's ${line.cents}`);
    const undecided =
      line.state === 'submitted' ||
      line.state === 'awaiting_decision' ||
      line.state === 'awaiting_explicit';
    if (b.decision === 'contest') {
      ensure(undecided, `a ${line.state} line cannot be contested`);
      ensure(b.reason !== undefined, 'a contest needs a reason');
    } else {
      // An upheld line is approved explicitly by its debtor (SPEC §6.6).
      const upheld =
        line.resolution === 'upheld' &&
        !line.approvedExplicitly &&
        (line.state === 'due' || line.state === 'overdue');
      ensure(undecided || upheld, `a ${line.state} line cannot be approved`);
    }
  },

  PAYMENT_MADE: (inner, ctx) => {
    const b = inner.body;
    const line = lineOf(ctx.trip, b.expenseEventHash, inner.author);
    ensure(!isFinal(line), `the line is already ${line.state}`);
    ensure(b.creditorPubkey === line.payerPubkey, 'creditor is not the payer of the expense');
    ensure(b.cents === line.cents, `cents ${b.cents} are not the line's ${line.cents}`);
    // On-chain: only the txid, which a pure function cannot look up (SPEC §10.3).
    if (b.rail === 'ln') checkPreimage(ctx, line, b.paymentHash, b.preimage);
  },

  EXPENSE_VOIDED: (inner, { trip }) => {
    const expense = trip.expenses.get(inner.body.expenseEventHash);
    ensure(expense !== undefined, 'unknown expense');
    ensure(expense.payerPubkey === inner.author, 'only the payer can void an expense');
    ensure(!expense.voided, 'expense already voided');
    const settled = [...trip.lines.values()].some(
      (l) =>
        l.expenseEventHash === expense.eventHash &&
        (l.state === 'paid' || l.state === 'guaranteed'),
    );
    ensure(!settled, 'a line is already paid: the expense cannot be voided');
  },

  DISPUTE_RESOLVED: (inner, { trip }) => {
    const line = lineOf(trip, inner.body.expenseEventHash, inner.body.debtorPubkey);
    ensure(line.state === 'contested', 'the line is not contested');
  },

  INVOICE_REISSUED: (inner, ctx) => {
    const { trip } = ctx;
    const b = inner.body;
    const expense = trip.expenses.get(b.expenseEventHash);
    ensure(expense !== undefined, 'unknown expense');
    ensure(expense.payerPubkey === inner.author, 'only the payer can reissue an invoice');
    const line = lineOf(trip, b.expenseEventHash, b.debtorPubkey);
    ensure(!isFinal(line), `the line is already ${line.state}`);
    const old = decode(ctx.deps, line.bolt11);
    ensure(Date.parse(old.expiresAt) <= ctx.at, 'the current invoice has not expired');
    const inv = checkLineInvoice(ctx, b.bolt11, {
      payer: member(trip, inner.author),
      debtor: member(trip, b.debtorPubkey),
      expenseId: expense.body.expenseId,
      cents: line.cents,
    });
    ensure(inv.paymentHash !== old.paymentHash, 'the new invoice has the same payment hash');
  },

  GUARANTEE_PAID: (inner, ctx) => {
    const { trip } = ctx;
    const b = inner.body;
    const line = lineOf(trip, b.expenseEventHash, b.debtorPubkey);
    ensure(line.state === 'overdue', 'only an overdue line can be covered');
    ensure(b.creditorPubkey === line.payerPubkey, 'creditor is not the payer of the expense');
    ensure(b.cents === line.cents, `cents ${b.cents} are not the line's ${line.cents}`);
    const debtor = member(trip, b.debtorPubkey);
    ensure(
      debtor.guaranteeUsedCents + b.cents <= trip.params.guaranteeCapCents,
      `over the guarantee cap for ${debtor.memberId}`,
    );
    checkPreimage(ctx, line, b.paymentHash, b.preimage);
  },

  MEMBER_EXCLUDED: (inner, { trip }) => {
    activeMember(trip, inner.body.memberPubkey);
  },

  CHECKPOINT: (inner, { trip }) => {
    // The heads are compared across phones (SPEC §9.4); here only that the seq exists.
    ensure(inner.body.seq <= (trip.head?.seq ?? 0), 'checkpoint of a seq not in the log');
  },

  TRIP_CLOSED: (_inner, { trip }) => {
    ensure([...trip.lines.values()].every(isFinal), 'open lines: the trip cannot be closed');
  },
};
