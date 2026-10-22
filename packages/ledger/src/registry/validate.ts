import {
  bindInvoiceRefusal,
  registry,
  sha256Hex,
  type DecodedInvoice,
  type SignatureVerifier,
} from '@kitty/shared';
import { paymentMatchesLine } from '../conflicts.js';
import { hexToBytes } from '../hex.js';
import { expenseFingerprint, expenseShares } from '../shares.js';
import {
  blocks,
  inTrip,
  isActive,
  isExcluded,
  lineKey,
  openDebtsOf,
  pairBlockRefusal,
  type Fold,
  type LineRecord,
} from './fold.js';

// validateRegistryEvent (step 2): the rules of one registry v2 event, checked on the state of
// what its author knew, i.e. the fold of its ancestors (plan §3.2). The same function runs on
// every phone; there is no relay that validates. Pure: signatures and invoice decoding are
// injected. Id and Nostr signature of the event are checked before (verifyNostrEvent).

export interface RegistryDeps {
  /** Schnorr verifier (schnorrVerifier in crypto.ts), for the signatures at the table. */
  verify: SignatureVerifier;
  /** BOLT11 decoder; the phone may also use its node. */
  decodeInvoice: (bolt11: string) => DecodedInvoice;
  /** sha256("kitty:trip:v1" ‖ tripSecret): the T tag, committed by the bind invoices. */
  tripTag: string;
}

/** An ISO date as unix seconds, truncated. */
export function unixSeconds(iso: string): number {
  const ms = Date.parse(iso);
  return (ms - (ms % 1000)) / 1000;
}

class Invalid extends Error {}

function ensure(condition: boolean, reason: string): asserts condition {
  if (!condition) throw new Invalid(reason);
}

/**
 * Null when `e` is valid on `known` (the fold of its ancestors), otherwise the reason. Never
 * throws: a decoder error is a rejection with its reason.
 */
export function validateRegistryEvent(
  e: registry.RegistryEvent,
  known: Fold,
  deps: RegistryDeps,
): string | null {
  try {
    check(e, known, deps);
    return null;
  } catch (err) {
    return err instanceof Invalid ? err.message : `rule check failed: ${String(err)}`;
  }
}

const short = (pk: string) => `${pk.slice(0, 8)}…`;

function check(e: registry.RegistryEvent, f: Fold, deps: RegistryDeps): void {
  const { content } = e;
  ensure(content.type !== 'TRIP_CREATED', 'the trip already exists');
  if (content.type !== 'MEMBER_JOINED')
    ensure(f.members.has(e.author), `${short(e.author)} is not a member of the trip`);

  switch (content.type) {
    case 'MEMBER_JOINED':
      return checkJoin(e, content.body, f, deps);
    case 'MEMBER_INVITED':
      ensure(isActive(f, e.author), 'only an active member can invite');
      ensure(
        ![...f.invites.values()].some((i) => i.body.inviteId === content.body.inviteId),
        'invite id already used',
      );
      return;
    case 'TRIP_SECRET_SHARED':
    case 'POLICY_UPDATED':
      return;
    case 'MEMBER_BLOCKED': {
      const { target } = content.body;
      ensure(isActive(f, e.author), 'only an active member can block');
      ensure(target !== e.author, 'a member cannot block itself');
      ensure(f.members.has(target), `${short(target)} is not a member of the trip`);
      return;
    }
    case 'MEMBER_UNBLOCKED':
      // C7: only who blocked, and only a block it knows.
      ensure(
        blocks(f, e.author, content.body.target),
        'only who blocked can unblock, after seeing its own block',
      );
      return;
    case 'MEMBER_LEFT': {
      ensure(inTrip(f, e.author), 'already left');
      const debts = openDebtsOf(f, e.author);
      ensure(
        debts.length === 0,
        `cannot leave with known debts: ${debts.length} open line(s), contested ones included`,
      );
      return;
    }
    case 'CHECKPOINT':
      ensure(
        isActive(f, e.author),
        'only an active member (not left, not excluded) can checkpoint',
      );
      return;
    case 'EXPENSE_SUBMITTED':
      return checkExpense(e, content.body, f, deps);
    case 'LINE_SEEN': {
      const line = lineOf(f, content.body.expenseRef, e.author);
      ensure(!line.signedAtTable, 'the debtor signed this line at the table');
      return;
    }
    case 'LINE_DECIDED': {
      // A member who left can still decide lines that arrived after leaving (C9).
      const b = content.body;
      const line = lineOf(f, b.expenseRef, e.author);
      ensure(b.amount === line.amount, `amount ${b.amount} is not the line's ${line.amount}`);
      ensure(b.decision === 'approve' || b.reason !== undefined, 'a contest needs a reason');
      return;
    }
    case 'PAYMENT_MADE': {
      // Always possible by hand [T], also on a contested or voided line (C2).
      const b = content.body;
      const line = lineOf(f, b.expenseRef, e.author);
      ensure(b.creditor === line.payer, 'creditor is not the payer of the expense');
      ensure(b.amount === line.amount, `amount ${b.amount} is not the line's ${line.amount}`);
      if (b.rail === 'ln') {
        ensure(
          sha256Hex(hexToBytes(b.preimage)) === b.paymentHash,
          'preimage does not match paymentHash',
        );
        const hashes = line.invoices.map((i) => ({
          paymentHash: decode(deps, i.bolt11).paymentHash,
        }));
        // C5: any invoice issued for the line that the debtor knew.
        ensure(paymentMatchesLine(b.paymentHash, hashes), 'paymentHash is not of a line invoice');
      }
      return;
    }
    case 'EXPENSE_VOIDED': {
      const expense = f.expenses.get(content.body.expenseRef);
      ensure(expense !== undefined, 'unknown expense');
      ensure(expense.payer === e.author, 'only the payer can void an expense');
      return;
    }
    case 'INVOICE_REISSUED': {
      const b = content.body;
      const expense = f.expenses.get(b.expenseRef);
      ensure(expense !== undefined, 'unknown expense');
      ensure(expense.payer === e.author, 'only the payer can reissue an invoice');
      const line = lineOf(f, b.expenseRef, b.debtor);
      const inv = checkInvoice(f, deps, b.bolt11, { line, createdAt: e.createdAt });
      ensure(
        line.invoices.every((i) => decode(deps, i.bolt11).paymentHash !== inv.paymentHash),
        'the new invoice has the payment hash of an old one',
      );
      return;
    }
  }
}

function lineOf(f: Fold, expenseRef: string, debtor: string): LineRecord {
  ensure(f.expenses.has(expenseRef), 'unknown expense');
  const line = f.lines.get(lineKey(expenseRef, debtor));
  ensure(line !== undefined, 'not a debtor of this expense');
  return line;
}

function decode(deps: RegistryDeps, bolt11: string): DecodedInvoice {
  try {
    return deps.decodeInvoice(bolt11);
  } catch (err) {
    throw new Invalid(`invoice not decodable: ${String(err)}`);
  }
}

function checkJoin(
  e: registry.RegistryEvent,
  b: registry.EventBody<'MEMBER_JOINED'>,
  f: Fold,
  deps: RegistryDeps,
): void {
  // Back after an exclusion: only with a new invite [22/10].
  const back = f.members.has(e.author);
  ensure(!back || isExcluded(f, e.author), 'already joined');
  ensure(!back || b.inviteRef !== null, 'an excluded member comes back only with a new invite');
  ensure(
    !back || f.members.get(e.author)?.nodePubkey === b.nodePubkey,
    'an excluded member comes back with the same node',
  );
  ensure(
    ![...f.members.values()].some((m) => m.pubkey !== e.author && m.nodePubkey === b.nodePubkey),
    'node already bound to a member',
  );
  if (b.inviteRef === null) {
    ensure(e.author === f.creator, 'only the trip creator joins without an invite');
  } else {
    const invite = f.invites.get(b.inviteRef);
    ensure(invite !== undefined, 'unknown invite');
    ensure(invite.usedBy === null, 'invite already used: one invite, one join (C13)');
    ensure(
      invite.body.inviteePubkey === undefined || invite.body.inviteePubkey === e.author,
      'the invite is for another key',
    );
    // created_at is the joiner's own clock: best effort, the invite is the real check.
    ensure(e.createdAt <= invite.body.expiresAt, 'the invite has expired');
    // TODO(D3): Sybil on invites, decided together with the exclusion policy (plan §11).
  }
  // kitty-bind:v2 (step 3): the member's node signs its registry key for this trip. From here
  // on nodePubkey is the node every invoice of this member must pay (invoiceRefusal).
  const bind = bindInvoiceRefusal(decode(deps, b.bindInvoice), {
    tripTag: deps.tripTag,
    registryPubkey: e.author,
    nodePubkey: b.nodePubkey,
  });
  ensure(bind === null, bind ?? '');
}

/**
 * Why `payer` cannot charge `debtors` in a new expense, or null. The single entry point the app
 * calls before it builds an expense (and validation calls on every one): debtors must be
 * distinct active members other than the payer, and no pair block (D6, pairBlockRefusal).
 */
export function expenseRefusal(f: Fold, payer: string, debtors: readonly string[]): string | null {
  if (!isActive(f, payer))
    return isExcluded(f, payer)
      ? 'you are excluded from the trip: you cannot register expenses'
      : 'you are not in the trip';
  if (new Set(debtors).size !== debtors.length) return 'a debtor appears twice';
  for (const d of debtors) {
    if (d === payer) return 'the payer cannot be a debtor';
    if (!f.members.has(d)) return `${short(d)} is not a member of the trip`;
    const name = f.members.get(d)?.displayName ?? short(d);
    if (!inTrip(f, d)) return `${name} has left the trip`;
    if (isExcluded(f, d)) return `${name} is excluded from the trip`;
    const blocked = pairBlockRefusal(f, payer, d);
    if (blocked !== null) return blocked;
  }
  return null;
}

function checkExpense(
  e: registry.RegistryEvent,
  b: registry.EventBody<'EXPENSE_SUBMITTED'>,
  f: Fold,
  deps: RegistryDeps,
): void {
  const p = b.proposal;
  const { params } = f.created;
  ensure(p.tripId === f.tripId, 'proposal of another trip');
  ensure(p.payer === e.author, 'the proposal names another payer');
  ensure(
    ![...f.expenses.values()].some(
      (x) => x.payer === e.author && x.body.proposal.expenseId === p.expenseId,
    ),
    `expense id ${p.expenseId} already used by this payer`,
  );
  const debtors = p.lines.map((l) => l.debtor);
  const refusal = expenseRefusal(f, e.author, debtors);
  ensure(refusal === null, refusal ?? '');

  ensure(p.assetId === params.assetId, 'not the trip asset');
  ensure(p.assetDecimals === params.assetDecimals, 'not the precision of the trip asset');

  const { receipt } = p;
  const itemsSum = receipt.items.reduce((a, it) => a + it.total, 0n);
  ensure(
    receipt.subtotal === undefined || receipt.subtotal === itemsSum,
    'subtotal is not the sum of the items',
  );
  ensure(
    itemsSum + (receipt.tax ?? 0n) + (receipt.tip ?? 0n) === receipt.total,
    'receipt total is not items + tax + tip',
  );
  ensure(
    p.rate.pair === `USD/${receipt.currency}`,
    `rate ${p.rate.pair} is not for ${receipt.currency}`,
  );
  ensure(receipt.currency !== 'USD' || p.rate.value === '1', 'a USD receipt has rate 1');

  // The ledger recomputes every share (CLAUDE.md rule 3): the LLM never computes money.
  const shares = expenseShares({
    receipt,
    rate: p.rate.value,
    assetDecimals: params.assetDecimals,
    payer: e.author,
    payerItemIndexes: p.payerItemIndexes,
    debtors: p.lines.map((l) => ({ id: l.debtor, itemIndexes: l.itemIndexes })),
  });
  const linesSum = p.lines.reduce((a, l) => a + l.amount, 0n);
  ensure(linesSum + p.payerAmount === p.total, 'Σ lines + payerAmount ≠ total');
  ensure(p.total === shares.totalUsdCents, 'total is not the converted receipt total');
  ensure(p.payerAmount === shares.payerCents, 'payerAmount is not the recomputed share');
  p.lines.forEach((l, i) =>
    ensure(
      l.amount === shares.debtors[i]?.cents,
      `share of ${short(l.debtor)} is not the recomputed one`,
    ),
  );
  ensure(
    b.fingerprint === expenseFingerprint(receipt, b.receiptImageSha256),
    'fingerprint does not match the receipt',
  );
  // Same fingerprint as another expense: valid, marked "possible duplicate" (C10, derive.ts).

  // Signatures at the table (D2): by debtors of the expense, on the proposal without invoices.
  const signers = b.tableSignatures.map((s) => s.signer);
  ensure(new Set(signers).size === signers.length, 'a debtor signed twice at the table');
  const digest = registry.proposalDigest(p);
  for (const s of b.tableSignatures) {
    ensure(debtors.includes(s.signer), `${short(s.signer)} signed but is not a debtor`);
    ensure(
      deps.verify.verify(s.signer, digest, s.sig),
      `invalid table signature of ${short(s.signer)}`,
    );
  }

  // One invoice per debtor, attached by the payer outside the signed proposal (D2).
  ensure(
    b.invoices.length === debtors.length &&
      debtors.every((d) => b.invoices.filter((i) => i.debtor === d).length === 1),
    'exactly one invoice per debtor',
  );
  const hashes = p.lines.map((l) => {
    const bolt11 = b.invoices.find((i) => i.debtor === l.debtor)?.bolt11 ?? '';
    return checkInvoice(f, deps, bolt11, {
      line: { payer: e.author, debtor: l.debtor, amount: l.amount },
      createdAt: e.createdAt,
    }).paymentHash;
  });
  ensure(new Set(hashes).size === hashes.length, 'two lines share one invoice');
}

/**
 * The invoice of a line when attached: payable to the payer's node, for the trip asset and the
 * line amount, and lasting at least invoiceExpirySeconds from the event that attaches it.
 */
function checkInvoice(
  f: Fold,
  deps: RegistryDeps,
  bolt11: string,
  x: { line: Pick<LineRecord, 'payer' | 'debtor' | 'amount'>; createdAt: number },
): DecodedInvoice {
  const inv = decode(deps, bolt11);
  const who = short(x.line.debtor);
  const payer = f.members.get(x.line.payer);
  ensure(payer !== undefined, 'the payer is not a member');
  ensure(inv.payeePubkey === payer.nodePubkey, `invoice for ${who} is payable to another node`);
  ensure(inv.assetId === f.created.params.assetId, `invoice for ${who} is not for the trip asset`);
  ensure(inv.cents === x.line.amount, `invoice for ${who} is not for ${x.line.amount}`);
  const expiresAt = unixSeconds(inv.expiresAt);
  ensure(
    expiresAt - x.createdAt >= f.created.params.invoiceExpirySeconds,
    `invoice for ${who} lasts less than ${f.created.params.invoiceExpirySeconds} s`,
  );
  return inv;
}
