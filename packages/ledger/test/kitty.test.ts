import fc from 'fast-check';
import {
  DEFAULT_POLICY,
  DEMO_TRIP_PARAMS,
  EVENT_TYPES,
  sha256Hex,
  signingMessage,
  storedEventHash,
  type DecodedInvoice,
  type EventBody,
  type Policy,
  type Receipt,
  type StoredEvent,
} from '@kitty/shared';
import { describe, expect, it } from 'vitest';
import {
  LedgerError,
  autoPaidLast24h,
  decideAutoPay,
  deriveTrip,
  expenseShares,
  lineKey,
  liquidityPlan,
  validateEvent,
  type TripState,
  type ValidationResult,
} from '../src/index.js';
import {
  ASSET_ID,
  KEY,
  Log,
  NODE,
  at,
  dinner,
  dinnerSpec,
  expenseBody,
  hex,
  joinBody,
  resign,
  submit,
  testSign,
  testVerifier,
  tripLog,
} from './helpers.js';

// The rules of stream A (PLAN.md §4, tasks A1-A3, A7). Reference numbers: the dinner of
// SPEC §15-16 (3.09 / 3.09 / 3.50).

const bodyOf = (e: StoredEvent) => e.signed.inner.body as EventBody<'EXPENSE_SUBMITTED'>;

describe('A1 deriveTrip (SPEC §7)', () => {
  // Demo params: silent assent 20 s, payment deadline 30 s. The dinner is submitted at t = 10.
  const derive = (log: Log, s: number) => {
    const trip = deriveTrip(log.events, at(s));
    if (trip === null) throw new Error('no trip');
    return trip;
  };
  const line = (trip: TripState, expense: StoredEvent, debtor: string) => {
    const l = trip.lines.get(lineKey(expense.hash, debtor));
    if (l === undefined) throw new Error('no line');
    return l;
  };
  const seen = (log: Log, expense: StoredEvent, debtor: string, s: number) =>
    log.push('LINE_SEEN', debtor, { expenseEventHash: expense.hash }, s);
  const decide = (
    log: Log,
    expense: StoredEvent,
    debtor: string,
    decision: 'approve' | 'contest',
    cents: bigint,
    s: number,
  ) =>
    log.push(
      'LINE_DECIDED',
      debtor,
      {
        expenseEventHash: expense.hash,
        decision,
        cents,
        ...(decision === 'contest' && { reason: 'I only had water' }),
      },
      s,
    );
  const pay = (log: Log, expense: StoredEvent, debtor: string, cents: bigint, s: number) =>
    log.push(
      'PAYMENT_MADE',
      debtor,
      {
        expenseEventHash: expense.hash,
        creditorPubkey: KEY.alice,
        cents,
        rail: 'ln',
        paymentHash: hex('1'),
        preimage: hex('2'),
      },
      s,
    );
  const resolve = (
    log: Log,
    expense: StoredEvent,
    debtor: string,
    outcome: 'upheld' | 'line_voided' | 'expense_voided',
    s: number,
  ) =>
    log.push(
      'DISPUTE_RESOLVED',
      KEY.dave,
      { expenseEventHash: expense.hash, debtorPubkey: debtor, outcome, note: 'checked the photo' },
      s,
    );
  const cover = (log: Log, expense: StoredEvent, debtor: string, cents: bigint, s: number) =>
    log.push(
      'GUARANTEE_PAID',
      KEY.dave,
      {
        expenseEventHash: expense.hash,
        debtorPubkey: debtor,
        creditorPubkey: KEY.alice,
        cents,
        paymentHash: hex('3'),
        preimage: hex('4'),
      },
      s,
    );
  const exclude = (log: Log, member: string, s: number) =>
    log.push(
      'MEMBER_EXCLUDED',
      KEY.dave,
      { memberPubkey: member, reason: 'did not pay', closingTxids: [hex('7')] },
      s,
    );
  const setup = () => {
    const log = tripLog();
    const expense = submit(log, dinnerSpec, 10);
    return { log, expense };
  };
  /** bob (3.09, within policy) has seen the dinner at t = 12. */
  const seenByBob = () => {
    const { log, expense } = setup();
    seen(log, expense, KEY.bob, 12);
    return { log, expense };
  };

  it('returns null for an empty log and rejects a log not starting with TRIP_CREATED', () => {
    expect(deriveTrip([], at(0))).toBeNull();
    const { log } = setup();
    expect(() => deriveTrip(log.events.slice(1), at(0))).toThrow(LedgerError);
  });

  it('EXPENSE_SUBMITTED creates one line per debtor in `submitted`; none for the payer', () => {
    const { log, expense } = setup();
    const trip = derive(log, 11);
    expect([...trip.lines.values()].map((l) => [l.debtorPubkey, l.state, l.cents])).toEqual([
      [KEY.bob, 'submitted', 309n],
      [KEY.charlie, 'submitted', 350n],
    ]);
    expect(trip.lines.has(lineKey(expense.hash, KEY.alice))).toBe(false);
    expect(trip.expenses.get(expense.hash)?.payerPubkey).toBe(KEY.alice);
    expect(trip.fingerprints.has(bodyOf(expense).fingerprint)).toBe(true);
    // No deadline runs until LINE_SEEN, however long the debtor sleeps.
    expect(line(derive(log, 100_000), expense, KEY.bob).state).toBe('submitted');
  });

  it('LINE_SEEN → awaiting_decision with deadline seenAt + silentAssentSeconds', () => {
    const { log, expense } = seenByBob();
    const l = line(derive(log, 13), expense, KEY.bob);
    expect(l.state).toBe('awaiting_decision');
    expect(l.seenAt).toEqual(at(12));
    expect(l.deadlineAt).toEqual(at(32));
    expect(l.paymentDeadlineAt).toEqual(at(42));
  });

  it('silent assent: before the deadline still awaiting_decision', () => {
    const { log, expense } = seenByBob();
    const trip = deriveTrip(log.events, new Date(at(32).getTime() - 1));
    expect(trip && line(trip, expense, KEY.bob).state).toBe('awaiting_decision');
  });

  it('silent assent: exactly at the deadline → due (within policy)', () => {
    const { log, expense } = seenByBob();
    const l = line(derive(log, 32), expense, KEY.bob);
    expect(l.state).toBe('due');
    expect(l.approvedExplicitly).toBe(false);
    expect(l.deadlineAt).toEqual(at(42));
  });

  it('silent assent: after the deadline → due (within policy)', () => {
    const { log, expense } = seenByBob();
    expect(line(derive(log, 35), expense, KEY.bob).state).toBe('due');
  });

  it('silent assent at exactly autoPayLimitCents still applies; above it → awaiting_explicit', () => {
    const { log, expense } = setup();
    log.push(
      'POLICY_UPDATED',
      KEY.bob,
      { policy: { ...DEFAULT_POLICY, autoPayLimitCents: 309n } },
      11,
    );
    log.push(
      'POLICY_UPDATED',
      KEY.charlie,
      { policy: { ...DEFAULT_POLICY, autoPayLimitCents: 349n } },
      11,
    );
    seen(log, expense, KEY.bob, 12);
    seen(log, expense, KEY.charlie, 12);
    const trip = derive(log, 32);
    expect(line(trip, expense, KEY.bob).state).toBe('due');
    const charlie = line(trip, expense, KEY.charlie);
    expect(charlie.state).toBe('awaiting_explicit');
    expect(charlie.deadlineAt).toEqual(at(42));
  });

  it('silent assent uses the policy in force at the deadline, not a later one', () => {
    const { log, expense } = seenByBob();
    log.push(
      'POLICY_UPDATED',
      KEY.bob,
      { policy: { ...DEFAULT_POLICY, autoPayLimitCents: 100n } },
      33,
    );
    expect(line(derive(log, 34), expense, KEY.bob).state).toBe('due');
  });

  it('awaiting_explicit unpaid past seenAt + paymentDeadlineSeconds → overdue (before / exactly / after)', () => {
    const { log, expense } = setup();
    log.push(
      'POLICY_UPDATED',
      KEY.charlie,
      { policy: { ...DEFAULT_POLICY, autoPayLimitCents: 100n } },
      11,
    );
    seen(log, expense, KEY.charlie, 12);
    const before = deriveTrip(log.events, new Date(at(42).getTime() - 1));
    expect(before && line(before, expense, KEY.charlie).state).toBe('awaiting_explicit');
    const exactly = line(derive(log, 42), expense, KEY.charlie);
    expect(exactly.state).toBe('overdue');
    expect(exactly.overdueAt).toEqual(at(42));
    expect(exactly.deadlineAt).toBeNull();
    expect(line(derive(log, 50), expense, KEY.charlie).state).toBe('overdue');
  });

  it('LINE_DECIDED approve → due; contest → contested with reason', () => {
    const { log, expense } = setup();
    seen(log, expense, KEY.bob, 12);
    seen(log, expense, KEY.charlie, 12);
    decide(log, expense, KEY.bob, 'approve', 309n, 14);
    decide(log, expense, KEY.charlie, 'contest', 350n, 15);
    const trip = derive(log, 16);
    const bob = line(trip, expense, KEY.bob);
    expect(bob.state).toBe('due');
    expect(bob.approvedExplicitly).toBe(true);
    expect(bob.deadlineAt).toEqual(at(42));
    const charlie = line(trip, expense, KEY.charlie);
    expect(charlie.state).toBe('contested');
    expect(charlie.contestReason).toBe('I only had water');
    expect(charlie.contestedAt).toEqual(at(15));
    expect(charlie.deadlineAt).toBeNull();
    // A contested line never goes overdue on its own.
    expect(line(derive(log, 10_000), expense, KEY.charlie).state).toBe('contested');
  });

  it('a decision after silent assent changes nothing; one before LINE_SEEN starts the clock', () => {
    const { log, expense } = setup();
    seen(log, expense, KEY.bob, 12);
    decide(log, expense, KEY.bob, 'contest', 309n, 32); // exactly at the deadline: too late
    decide(log, expense, KEY.charlie, 'approve', 350n, 20); // no LINE_SEEN before
    const trip = derive(log, 33);
    expect(line(trip, expense, KEY.bob).state).toBe('due');
    const charlie = line(trip, expense, KEY.charlie);
    expect(charlie.state).toBe('due');
    expect(charlie.seenAt).toEqual(at(20));
    expect(charlie.paymentDeadlineAt).toEqual(at(50));
  });

  it('upheldDeadlineSeconds: a short time to pay an upheld line, the other deadlines unchanged', () => {
    // the live demo: 10 s after dave upholds, against 30 s from LINE_SEEN for the others
    const log = tripLog({ ...DEMO_TRIP_PARAMS, upheldDeadlineSeconds: 10 });
    const expense = submit(log, dinnerSpec, 10);
    seen(log, expense, KEY.bob, 12);
    seen(log, expense, KEY.charlie, 12);
    decide(log, expense, KEY.charlie, 'contest', 350n, 15);
    resolve(log, expense, KEY.charlie, 'upheld', 20);
    expect(line(derive(log, 21), expense, KEY.charlie).deadlineAt).toEqual(at(30));
    expect(line(derive(log, 29), expense, KEY.charlie).state).toBe('due');
    expect(line(derive(log, 30), expense, KEY.charlie).state).toBe('overdue');
    // bob's line keeps seenAt + paymentDeadlineSeconds: due at 32 (silent assent), overdue at 42
    expect(line(derive(log, 41), expense, KEY.bob).state).toBe('due');
    expect(line(derive(log, 42), expense, KEY.bob).state).toBe('overdue');
  });

  it('DISPUTE_RESOLVED upheld → due with a new deadline; line_voided → voided; expense_voided → every line voided', () => {
    const contested = () => {
      const { log, expense } = setup();
      seen(log, expense, KEY.bob, 12);
      seen(log, expense, KEY.charlie, 12);
      decide(log, expense, KEY.charlie, 'contest', 350n, 15);
      return { log, expense };
    };

    const upheld = contested();
    resolve(upheld.log, upheld.expense, KEY.charlie, 'upheld', 60);
    const u = line(derive(upheld.log, 61), upheld.expense, KEY.charlie);
    expect(u.state).toBe('due');
    expect(u.resolution).toBe('upheld');
    expect(u.approvedExplicitly).toBe(false);
    expect(u.deadlineAt).toEqual(at(90));
    expect(line(derive(upheld.log, 90), upheld.expense, KEY.charlie).state).toBe('overdue');

    const lineVoided = contested();
    resolve(lineVoided.log, lineVoided.expense, KEY.charlie, 'line_voided', 60);
    const lv = derive(lineVoided.log, 61);
    expect(line(lv, lineVoided.expense, KEY.charlie).state).toBe('voided');
    expect(line(lv, lineVoided.expense, KEY.bob).state).toBe('overdue'); // bob's own deadline, 42

    const expenseVoided = contested();
    pay(expenseVoided.log, expenseVoided.expense, KEY.bob, 309n, 33);
    resolve(expenseVoided.log, expenseVoided.expense, KEY.charlie, 'expense_voided', 60);
    const ev = derive(expenseVoided.log, 61);
    expect(line(ev, expenseVoided.expense, KEY.charlie).state).toBe('voided');
    // What is already paid stays paid; the expense is voided and its fingerprint released.
    expect(line(ev, expenseVoided.expense, KEY.bob).state).toBe('paid');
    expect(ev.expenses.get(expenseVoided.expense.hash)?.voided).toBe(true);
    expect(ev.fingerprints.has(bodyOf(expenseVoided.expense).fingerprint)).toBe(false);
  });

  it('due unpaid past the deadline → overdue', () => {
    const { log, expense } = seenByBob();
    expect(line(derive(log, 41), expense, KEY.bob).state).toBe('due');
    const l = line(derive(log, 42), expense, KEY.bob);
    expect(l.state).toBe('overdue');
    expect(l.overdueAt).toEqual(at(42));
  });

  it('PAYMENT_MADE → paid (also from overdue: late payment)', () => {
    const { log, expense } = seenByBob();
    pay(log, expense, KEY.bob, 309n, 33);
    const trip = derive(log, 100);
    const l = line(trip, expense, KEY.bob);
    expect(l.state).toBe('paid');
    expect(l.payment).toEqual({
      by: 'debtor',
      rail: 'ln',
      paymentHash: hex('1'),
      preimage: hex('2'),
      at: at(33),
    });
    // Paid on silent assent: counts against the daily cap.
    expect(trip.autoPayments.get(KEY.bob)).toEqual([{ at: at(33), cents: 309n }]);

    const late = seenByBob();
    late.log.push(
      'PAYMENT_MADE',
      KEY.bob,
      {
        expenseEventHash: late.expense.hash,
        creditorPubkey: KEY.alice,
        cents: 309n,
        rail: 'onchain',
        txid: hex('5'),
      },
      50,
    );
    const lateLine = line(derive(late.log, 51), late.expense, KEY.bob);
    expect(lateLine.state).toBe('paid');
    expect(lateLine.overdueAt).toEqual(at(42));
  });

  it('a payment after an explicit approval is not automatic', () => {
    const { log, expense } = seenByBob();
    decide(log, expense, KEY.bob, 'approve', 309n, 13);
    pay(log, expense, KEY.bob, 309n, 14);
    expect(derive(log, 15).autoPayments.get(KEY.bob)).toBeUndefined();
  });

  it('GUARANTEE_PAID → guaranteed; guaranteeUsedCents grows for the debtor', () => {
    const { log, expense } = setup();
    seen(log, expense, KEY.charlie, 12);
    decide(log, expense, KEY.charlie, 'approve', 350n, 13);
    cover(log, expense, KEY.charlie, 350n, 45);
    const trip = derive(log, 46);
    const l = line(trip, expense, KEY.charlie);
    expect(l.state).toBe('guaranteed');
    expect(l.payment).toEqual({
      by: 'guarantee',
      paymentHash: hex('3'),
      preimage: hex('4'),
      at: at(45),
    });
    expect(trip.members.get(KEY.charlie)?.guaranteeUsedCents).toBe(350n);
    expect(trip.members.get(KEY.bob)?.guaranteeUsedCents).toBe(0n);
  });

  it('EXPENSE_VOIDED → every line voided', () => {
    const { log, expense } = setup();
    log.push('EXPENSE_VOIDED', KEY.alice, { expenseEventHash: expense.hash }, 11);
    const trip = derive(log, 12);
    expect([...trip.lines.values()].map((l) => l.state)).toEqual(['voided', 'voided']);
    expect(trip.expenses.get(expense.hash)?.voided).toBe(true);
    expect(trip.members.get(KEY.alice)?.owedToMeCents).toBe(0n);
    // The corrected expense can be submitted again with the same fingerprint.
    expect(trip.fingerprints.has(bodyOf(expense).fingerprint)).toBe(false);
  });

  it('INVOICE_REISSUED replaces the line invoice', () => {
    const { log, expense } = setup();
    log.push(
      'INVOICE_REISSUED',
      KEY.alice,
      { expenseEventHash: expense.hash, debtorPubkey: KEY.bob, bolt11: 'lnbcrt1reissued' },
      11,
    );
    const trip = derive(log, 12);
    expect(line(trip, expense, KEY.bob).bolt11).toBe('lnbcrt1reissued');
    expect(line(trip, expense, KEY.charlie).bolt11).toBe(bodyOf(expense).lines[1]?.bolt11);
  });

  it('MEMBER_EXCLUDED → member excluded, their open lines overdue at once', () => {
    const { log, expense } = setup();
    seen(log, expense, KEY.charlie, 12);
    decide(log, expense, KEY.charlie, 'contest', 350n, 13);
    const other = submit(
      log,
      {
        payer: KEY.charlie,
        receipt: dinner,
        payerItemIndexes: [1, 2],
        debtors: [{ id: KEY.bob, itemIndexes: [0, 2] }],
        expenseId: 'lunch',
      },
      14,
    );
    exclude(log, KEY.charlie, 20);
    const trip = derive(log, 21);
    const m = trip.members.get(KEY.charlie);
    expect(m?.excluded).toBe(true);
    expect(m?.closingTxids).toEqual([hex('7')]);
    const l = line(trip, expense, KEY.charlie);
    expect(l.state).toBe('overdue');
    expect(l.overdueAt).toEqual(at(20));
    // What others owe the excluded member is still owed (paid on-chain, SPEC §6.7).
    expect(line(trip, other, KEY.bob).state).toBe('submitted');
  });

  it('owed and to-receive totals per member; defaults list for dave', () => {
    const { log, expense } = setup();
    seen(log, expense, KEY.bob, 12);
    seen(log, expense, KEY.charlie, 13);
    const open = derive(log, 14);
    expect(open.members.get(KEY.alice)?.owedToMeCents).toBe(659n);
    expect(open.members.get(KEY.bob)?.oweCents).toBe(309n);
    expect(open.members.get(KEY.charlie)?.oweCents).toBe(350n);
    expect(open.defaults).toEqual([]);

    const trip = derive(log, 43);
    expect(trip.defaults.map((l) => [l.debtorPubkey, l.overdueAt])).toEqual([
      [KEY.bob, at(42)],
      [KEY.charlie, at(43)],
    ]);
    // Overdue is still open: still owed.
    expect(trip.members.get(KEY.alice)?.owedToMeCents).toBe(659n);
  });

  it('the demo dinner: alice is owed 3.09 by bob and 3.50 by charlie', () => {
    // SPEC §16 steps 2-7: bob pays on silent assent, charlie contests, dave upholds, charlie
    // does not pay, dave covers and excludes.
    const { log, expense } = setup();
    const body = expense.signed.inner.body as EventBody<'EXPENSE_SUBMITTED'>;
    expect(body.totalUsdCents).toBe(968n);
    expect(body.payerCents).toBe(309n);
    seen(log, expense, KEY.bob, 11);
    seen(log, expense, KEY.charlie, 11);
    const start = derive(log, 12);
    expect(start.members.get(KEY.alice)?.owedToMeCents).toBe(659n);

    decide(log, expense, KEY.charlie, 'contest', 350n, 20);
    pay(log, expense, KEY.bob, 309n, 32);
    resolve(log, expense, KEY.charlie, 'upheld', 40);
    expect(line(derive(log, 69), expense, KEY.charlie).state).toBe('due');
    const late = derive(log, 70);
    expect(late.defaults.map((l) => l.debtorPubkey)).toEqual([KEY.charlie]);

    cover(log, expense, KEY.charlie, 350n, 75);
    exclude(log, KEY.charlie, 76);
    const end = derive(log, 100);
    expect(line(end, expense, KEY.bob).state).toBe('paid');
    expect(line(end, expense, KEY.charlie).state).toBe('guaranteed');
    expect(end.members.get(KEY.alice)?.owedToMeCents).toBe(0n);
    expect(end.members.get(KEY.charlie)?.guaranteeUsedCents).toBe(350n);
    expect(end.members.get(KEY.charlie)?.excluded).toBe(true);
    expect(end.defaults).toEqual([]);
    expect(end.head?.seq).toBe(log.events.length);
    expect(end.noncesSeen.size).toBe(log.events.length);
  });

  it('property (fast-check): Σ lines + payerCents = totalUsdCents for every expense', () => {
    const debtors = [KEY.bob, KEY.charlie, KEY.dave];
    const arb = fc
      .record({
        totals: fc.array(fc.bigInt({ min: 1n, max: 5_000_000n }), { minLength: 1, maxLength: 6 }),
        tip: fc.bigInt({ min: 0n, max: 500_000n }),
        rate: fc.constantFrom('26350', '1', '0.86', '150.5', '25000.25'),
        // For each item, who shares it: bit 0 = alice (payer), bits 1-3 = debtors; never nobody.
        masks: fc.array(fc.integer({ min: 1, max: 15 }), { minLength: 6, maxLength: 6 }),
      })
      .map(({ totals, tip, rate, masks }) => {
        const items = totals.map((total, i) => ({
          label: `item ${i}`,
          quantity: 1,
          unitPrice: total,
          total,
        }));
        const sharing = (bit: number) =>
          items.map((_, i) => i).filter((i) => ((masks[i] ?? 1) >> bit) & 1);
        const receipt: Receipt = {
          ...dinner,
          items,
          subtotal: undefined,
          tip,
          total: totals.reduce((a, b) => a + b, 0n) + tip,
        };
        return {
          receipt,
          rate,
          payerItemIndexes: sharing(0),
          debtors: debtors
            .map((id, d) => ({ id, itemIndexes: sharing(d + 1) }))
            .filter((d) => d.itemIndexes.length > 0),
        };
      })
      .filter((x) => x.debtors.length > 0);

    fc.assert(
      fc.property(arb, ({ receipt, rate, payerItemIndexes, debtors: ds }) => {
        const shares = expenseShares({
          receipt,
          rate,
          payer: KEY.alice,
          payerItemIndexes,
          debtors: ds,
        });
        const sum = shares.debtors.reduce((a, d) => a + d.cents, 0n);
        expect(sum + shares.payerCents).toBe(shares.totalUsdCents);
        // And deriveTrip keeps exactly those cents on the lines.
        const log = tripLog();
        // A signed line needs cents > 0 (positiveMinorString): zero shares are not submitted.
        if (shares.debtors.some((d) => d.cents === 0n)) return;
        const e = submit(
          log,
          { payer: KEY.alice, receipt, payerItemIndexes, debtors: ds, rate },
          1,
        );
        const trip = deriveTrip(log.events, at(2));
        const body = e.signed.inner.body as EventBody<'EXPENSE_SUBMITTED'>;
        const lines = [...(trip?.lines.values() ?? [])];
        expect(lines.reduce((a, l) => a + l.cents, 0n) + body.payerCents).toBe(body.totalUsdCents);
      }),
    );
  });
});

describe('expenseShares', () => {
  it('the dinner: 3.09 / 3.09 / 3.50 out of 9.68', () => {
    const s = expenseShares({
      receipt: dinner,
      rate: '26350',
      payer: KEY.alice,
      payerItemIndexes: [0, 2],
      debtors: [
        { id: KEY.bob, itemIndexes: [0, 2] },
        { id: KEY.charlie, itemIndexes: [1, 2] },
      ],
    });
    expect(s).toEqual({
      totalUsdCents: 968n,
      payerCents: 309n,
      debtors: [
        { id: KEY.bob, cents: 309n },
        { id: KEY.charlie, cents: 350n },
      ],
    });
  });

  it('rejects an index out of range and an item shared by nobody', () => {
    const base = { receipt: dinner, rate: '26350', payer: KEY.alice };
    expect(() => expenseShares({ ...base, payerItemIndexes: [0, 1, 2, 3], debtors: [] })).toThrow(
      LedgerError,
    );
    expect(() =>
      expenseShares({
        ...base,
        payerItemIndexes: [0],
        debtors: [{ id: KEY.bob, itemIndexes: [1] }],
      }),
    ).toThrow(/shared by nobody/);
  });
});

describe('A2 validateEvent (SPEC §9.3)', () => {
  const rejected = (r: ValidationResult, reason: RegExp) => {
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(reason);
  };
  const lineOf = (e: StoredEvent, i: number) => {
    const l = bodyOf(e).lines[i];
    if (l === undefined) throw new Error('no line');
    return l;
  };
  const payBody = (log: Log, e: StoredEvent, i: number, creditor: string) => {
    const l = lineOf(e, i);
    return {
      expenseEventHash: e.hash,
      creditorPubkey: creditor,
      cents: l.cents,
      rail: 'ln' as const,
      ...log.proof(l.bolt11),
    };
  };
  /** The dinner submitted at t = 10 and seen by both debtors at t = 11. */
  const dinnerSeen = () => {
    const log = tripLog();
    const expense = submit(log, dinnerSpec, 10);
    log.push('LINE_SEEN', KEY.bob, { expenseEventHash: expense.hash }, 11);
    log.push('LINE_SEEN', KEY.charlie, { expenseEventHash: expense.hash }, 11);
    return { log, expense };
  };
  const taxi: Receipt = {
    merchant: 'Taxi',
    date: '2026-10-17',
    currency: 'USD',
    items: [{ label: 'Taxi', quantity: 1, unitPrice: 1000n, total: 1000n }],
    total: 1000n,
    warnings: [],
  };

  it('accepts a valid event of every type', () => {
    const log = tripLog();
    log.push('POLICY_UPDATED', KEY.bob, { policy: { ...DEFAULT_POLICY, dailyCapCents: 8000n } }, 5);
    const expense = submit(log, dinnerSpec, 10);
    log.push('LINE_SEEN', KEY.bob, { expenseEventHash: expense.hash }, 11);
    log.push('LINE_SEEN', KEY.charlie, { expenseEventHash: expense.hash }, 11);
    log.push('CHECKPOINT', KEY.bob, { seq: log.events.length, headHash: expense.hash }, 12);
    log.push(
      'LINE_DECIDED',
      KEY.charlie,
      { expenseEventHash: expense.hash, decision: 'contest', cents: 350n, reason: 'only water' },
      15,
    );
    log.push('PAYMENT_MADE', KEY.bob, payBody(log, expense, 0, KEY.alice), 32);
    log.push(
      'DISPUTE_RESOLVED',
      KEY.dave,
      { expenseEventHash: expense.hash, debtorPubkey: KEY.charlie, outcome: 'upheld', note: 'ok' },
      40,
    );
    // charlie does not pay by 70: dave covers and excludes.
    const charlieLine = lineOf(expense, 1);
    log.push(
      'GUARANTEE_PAID',
      KEY.dave,
      {
        expenseEventHash: expense.hash,
        debtorPubkey: KEY.charlie,
        creditorPubkey: KEY.alice,
        cents: charlieLine.cents,
        ...log.proof(charlieLine.bolt11),
      },
      75,
    );
    log.push(
      'MEMBER_EXCLUDED',
      KEY.dave,
      { memberPubkey: KEY.charlie, reason: 'did not pay', closingTxids: [hex('7')] },
      76,
    );
    // bob submits and voids a snack, then a taxi in USD that alice pays after a reissue.
    const snackSpec = {
      payer: KEY.bob,
      receipt: taxi,
      payerItemIndexes: [0],
      debtors: [{ id: KEY.alice, itemIndexes: [0] }],
      expenseId: 'snack',
      rate: '1',
    };
    const snack = submit(log, snackSpec, 100);
    log.push('EXPENSE_VOIDED', KEY.bob, { expenseEventHash: snack.hash }, 101);
    const ride = submit(log, { ...snackSpec, expenseId: 'taxi' }, 110);
    log.push('LINE_SEEN', KEY.alice, { expenseEventHash: ride.hash }, 111);
    log.push(
      'LINE_DECIDED',
      KEY.alice,
      { expenseEventHash: ride.hash, decision: 'approve', cents: 500n },
      112,
    );
    const reissued = log.invoice({
      payee: NODE(KEY.bob),
      cents: 500n,
      description: 'kitty:vietnam-2026:taxi:alice',
      expiresAtS: 3800 + 3600,
    });
    log.push(
      'INVOICE_REISSUED',
      KEY.bob,
      { expenseEventHash: ride.hash, debtorPubkey: KEY.alice, bolt11: reissued },
      3800,
    );
    log.push(
      'PAYMENT_MADE',
      KEY.alice,
      {
        expenseEventHash: ride.hash,
        creditorPubkey: KEY.bob,
        cents: 500n,
        rail: 'ln',
        ...log.proof(reissued),
      },
      3801,
    );
    log.push('TRIP_CLOSED', KEY.dave, { summary: 'all settled' }, 3802);
    log.push('CHECKPOINT', KEY.alice, { seq: log.events.length, headHash: hex('0') }, 3803);

    expect(new Set(log.events.map((e) => e.signed.inner.type))).toEqual(new Set(EVENT_TYPES));
    const results = log.checkAll();
    results.forEach((r, i) => {
      expect({ i, type: log.events[i]?.signed.inner.type, ...r }).toMatchObject({ ok: true });
    });
    const end = deriveTrip(log.events, at(3900));
    expect(end?.closed).toBe(true);
  });

  it('accepts an on-chain payment with its txid (SPEC §10.3)', () => {
    const { log, expense } = dinnerSeen();
    const e = log.build(
      'PAYMENT_MADE',
      KEY.bob,
      {
        expenseEventHash: expense.hash,
        creditorPubkey: KEY.alice,
        cents: 309n,
        rail: 'onchain',
        txid: hex('5'),
      },
      20,
    );
    expect(log.check(e)).toEqual({ ok: true });
  });

  it('rejects a bad signature (injected verifier)', () => {
    const { log, expense } = dinnerSeen();
    const e = log.build('PAYMENT_MADE', KEY.bob, payBody(log, expense, 0, KEY.alice), 20);
    const forged = { ...e, signed: { ...e.signed, sig: testSign(KEY.charlie, 'something else') } };
    const rehashed = { ...forged, hash: storedEventHash(forged) };
    rejected(log.check(rehashed), /invalid signature/);
    // Same body signed by charlie but claiming bob as author.
    const other = {
      ...e,
      signed: { ...e.signed, sig: testSign(KEY.charlie, signingMessage(e.signed.inner)) },
    };
    rejected(log.check({ ...other, hash: storedEventHash(other) }), /invalid signature/);
  });

  it('rejects a duplicate nonce (replay)', () => {
    const { log, expense } = dinnerSeen();
    const e = log.build('PAYMENT_MADE', KEY.bob, payBody(log, expense, 0, KEY.alice), 20);
    const used = log.events[3]?.signed.inner.nonce ?? '';
    rejected(log.check(resign(e, { ...e.signed.inner, nonce: used })), /replay/);
    // A whole event replayed: wrong position in the chain, and its nonce is known.
    const old = log.events.at(-1);
    if (old) rejected(log.check(old), /seq/);
  });

  it('rejects an event for another trip', () => {
    const { log } = dinnerSeen();
    const e = log.build('POLICY_UPDATED', KEY.bob, { policy: DEFAULT_POLICY }, 20);
    rejected(log.check(resign(e, { ...e.signed.inner, tripId: 'other-trip' })), /trip/);
  });

  it('rejects a broken chain: wrong seq, wrong prevHash, wrong hash', () => {
    const { log } = dinnerSeen();
    const e = log.build('POLICY_UPDATED', KEY.bob, { policy: DEFAULT_POLICY }, 20);
    const withSeq = { ...e, seq: e.seq + 1 };
    rejected(log.check({ ...withSeq, hash: storedEventHash(withSeq) }), /seq/);
    const withPrev = { ...e, prevHash: hex('e') };
    rejected(log.check({ ...withPrev, hash: storedEventHash(withPrev) }), /prevHash/);
    rejected(log.check({ ...e, hash: hex('e') }), /hash does not match/);
    expect(log.check(e)).toEqual({ ok: true });
  });

  it('rejects a coordinator type signed by someone else, and a member type signed by dave', () => {
    const log = tripLog();
    rejected(
      log.check(
        log.build(
          'RATE_SET',
          KEY.alice,
          { asOf: '2026-10-17', source: 'me', rates: { VND: '1' } },
          1,
        ),
      ),
      /only be signed by the coordinator/,
    );
    rejected(
      log.check(
        log.build(
          'MEMBER_EXCLUDED',
          KEY.bob,
          { memberPubkey: KEY.charlie, reason: 'x', closingTxids: [] },
          1,
        ),
      ),
      /coordinator/,
    );
    rejected(
      log.check(log.build('EXPENSE_SUBMITTED', KEY.dave, expenseBody(log, dinnerSpec, 1), 1)),
      /cannot be signed by the coordinator/,
    );
  });

  it('rejects an author not admitted (except TRIP_CREATED, MEMBER_JOINED)', () => {
    const log = new Log();
    const created = log.build(
      'TRIP_CREATED',
      KEY.dave,
      {
        name: 'Vietnam 2026',
        assetId: ASSET_ID,
        params: DEMO_TRIP_PARAMS,
        coordinatorPubkey: KEY.dave,
      },
      0,
    );
    expect(log.check(created)).toEqual({ ok: true });
    rejected(
      log.check(resign(created, { ...created.signed.inner, author: KEY.alice })),
      /coordinator it names/,
    );
    log.events.push(created);
    rejected(
      log.check(
        log.build(
          'TRIP_CREATED',
          KEY.dave,
          created.signed.inner.body as EventBody<'TRIP_CREATED'>,
          0,
        ),
      ),
      /already exists/,
    );
    const joined = log.build('MEMBER_JOINED', KEY.bob, joinBody(log, 'bob'), 1);
    expect(log.check(joined)).toEqual({ ok: true });
    log.events.push(joined);
    // Joined but not admitted yet.
    rejected(
      log.check(log.build('POLICY_UPDATED', KEY.bob, { policy: DEFAULT_POLICY }, 2)),
      /not admitted/,
    );
    // A key nobody knows.
    rejected(
      log.check(log.build('CHECKPOINT', hex('9'), { seq: 1, headHash: created.hash }, 2)),
      /not admitted/,
    );
  });

  it('rejects a log that does not start with TRIP_CREATED', () => {
    const log = new Log();
    rejected(
      log.check(log.build('MEMBER_JOINED', KEY.bob, joinBody(log, 'bob'), 0)),
      /first event must be TRIP_CREATED/,
    );
  });

  it('rejects a MEMBER_JOINED whose bind invoice is from another node', () => {
    const log = tripLog().events.slice(0, 2);
    const fresh = new Log();
    fresh.events.push(...log);
    const body = joinBody(fresh, 'bob');
    const fromAlice = fresh.invoice({
      payee: NODE(KEY.alice),
      cents: null,
      assetId: null,
      description: `kitty-bind:${sha256Hex(KEY.bob)}`,
      expiresAtS: 3600,
    });
    rejected(
      fresh.check(fresh.build('MEMBER_JOINED', KEY.bob, { ...body, bindInvoice: fromAlice }, 1)),
      /bind invoice is from another node/,
    );
    const wrongKey = fresh.invoice({
      payee: NODE(KEY.bob),
      cents: null,
      assetId: null,
      description: `kitty-bind:${sha256Hex(KEY.charlie)}`,
      expiresAtS: 3600,
    });
    rejected(
      fresh.check(fresh.build('MEMBER_JOINED', KEY.bob, { ...body, bindInvoice: wrongKey }, 1)),
      /does not commit to the appPubkey/,
    );
    rejected(
      fresh.check(fresh.build('MEMBER_JOINED', KEY.bob, { ...body, bindInvoice: null }, 1)),
      /bind invoice is required/,
    );
    rejected(
      fresh.check(fresh.build('MEMBER_JOINED', KEY.charlie, body, 1)),
      /signed by its appPubkey/,
    );
    expect(fresh.check(fresh.build('MEMBER_JOINED', KEY.bob, body, 1))).toEqual({ ok: true });
  });

  it('rejects a second MEMBER_JOINED for the same member', () => {
    const log = tripLog();
    rejected(
      log.check(log.build('MEMBER_JOINED', KEY.bob, joinBody(log, 'bob'), 1)),
      /already joined/,
    );
  });

  it('rejects EXPENSE_SUBMITTED with a duplicate fingerprint', () => {
    const log = tripLog();
    submit(log, dinnerSpec, 10);
    const again = expenseBody(
      log,
      { ...dinnerSpec, expenseId: 'dinner-again', receiptImageSha256: sha256Hex('photo dinner') },
      20,
    );
    rejected(log.check(log.build('EXPENSE_SUBMITTED', KEY.alice, again, 20)), /duplicate receipt/);
    const forged = expenseBody(log, { ...dinnerSpec, expenseId: 'dinner-2' }, 20);
    rejected(
      log.check(
        log.build('EXPENSE_SUBMITTED', KEY.alice, { ...forged, fingerprint: hex('8') }, 20),
      ),
      /fingerprint does not match/,
    );
    rejected(
      log.check(log.build('EXPENSE_SUBMITTED', KEY.alice, expenseBody(log, dinnerSpec, 20), 20)),
      /expense id dinner already used/,
    );
  });

  it('rejects EXPENSE_SUBMITTED whose totals do not add up (receipt or USD)', () => {
    const log = tripLog();
    const body = expenseBody(log, dinnerSpec, 10);
    const send = (b: EventBody<'EXPENSE_SUBMITTED'>) =>
      log.check(log.build('EXPENSE_SUBMITTED', KEY.alice, b, 10));
    rejected(send({ ...body, receipt: { ...dinner, total: 256_000n } }), /items \+ tax \+ tip/);
    rejected(send({ ...body, receipt: { ...dinner, subtotal: 1n } }), /subtotal/);
    rejected(send({ ...body, payerCents: 310n }), /Σ lines \+ payerCents/);
    // Σ still adds up, but alice moved one cent onto bob.
    const [bob, charlie] = body.lines;
    if (!bob || !charlie) throw new Error('lines');
    rejected(
      send({ ...body, payerCents: 308n, lines: [{ ...bob, cents: 310n }, charlie] }),
      /recomputed/,
    );
    rejected(send({ ...body, totalUsdCents: 1000n, payerCents: 341n }), /converted total/);
    rejected(send({ ...body, rate: '25000' }), /not the RATE_SET rate/);
    rejected(
      send({ ...body, lines: [{ ...bob, itemIndexes: [0, 7] }, charlie] }),
      /does not exist on the receipt/,
    );
    expect(send(body)).toEqual({ ok: true });
  });

  it('rejects EXPENSE_SUBMITTED with a rate that is not the latest RATE_SET', () => {
    const log = tripLog();
    const body = expenseBody(log, dinnerSpec, 10);
    log.push('RATE_SET', KEY.dave, { asOf: '2026-10-18', source: 'x', rates: { VND: '26350' } }, 5);
    rejected(log.check(log.build('EXPENSE_SUBMITTED', KEY.alice, body, 10)), /latest RATE_SET/);
  });

  it('rejects EXPENSE_SUBMITTED with an excluded debtor', () => {
    const log = tripLog();
    log.push(
      'MEMBER_EXCLUDED',
      KEY.dave,
      { memberPubkey: KEY.charlie, reason: 'x', closingTxids: [] },
      5,
    );
    rejected(
      log.check(log.build('EXPENSE_SUBMITTED', KEY.alice, expenseBody(log, dinnerSpec, 10), 10)),
      /charlie is excluded/,
    );
    // Nor can the excluded member submit.
    const spec = {
      ...dinnerSpec,
      payer: KEY.charlie,
      debtors: [{ id: KEY.bob, itemIndexes: [0, 2] }],
      payerItemIndexes: [0, 1, 2],
    };
    rejected(
      log.check(log.build('EXPENSE_SUBMITTED', KEY.charlie, expenseBody(log, spec, 10), 10)),
      /charlie is excluded/,
    );
  });

  it('rejects EXPENSE_SUBMITTED with the payer, dave or a twice-listed member as debtor', () => {
    const log = tripLog();
    const body = expenseBody(log, dinnerSpec, 10);
    const [bob, charlie] = body.lines;
    if (!bob || !charlie) throw new Error('lines');
    const send = (b: EventBody<'EXPENSE_SUBMITTED'>) =>
      log.check(log.build('EXPENSE_SUBMITTED', KEY.alice, b, 10));
    rejected(
      send({ ...body, lines: [{ ...bob, debtorPubkey: KEY.alice }, charlie] }),
      /payer cannot be a debtor/,
    );
    rejected(
      send({ ...body, lines: [{ ...bob, debtorPubkey: KEY.dave }, charlie] }),
      /coordinator cannot be a debtor/,
    );
    rejected(
      send({ ...body, lines: [bob, { ...charlie, debtorPubkey: KEY.bob }] }),
      /appears twice/,
    );
  });

  it('rejects EXPENSE_SUBMITTED with an invoice payable to another node', () => {
    const log = tripLog();
    const body = expenseBody(log, dinnerSpec, 10);
    const [bob, charlie] = body.lines;
    if (!bob || !charlie) throw new Error('lines');
    // SPEC §13 #1: a server swaps alice's invoice for its own.
    const swapped = log.invoice({
      payee: NODE(hex('9')),
      cents: 309n,
      description: 'kitty:vietnam-2026:dinner:bob',
      expiresAtS: 3600,
    });
    rejected(
      log.check(
        log.build(
          'EXPENSE_SUBMITTED',
          KEY.alice,
          { ...body, lines: [{ ...bob, bolt11: swapped }, charlie] },
          10,
        ),
      ),
      /invoice for bob is payable to another node/,
    );
    rejected(
      log.check(
        log.build(
          'EXPENSE_SUBMITTED',
          KEY.alice,
          { ...body, lines: [{ ...bob, bolt11: 'lnbcrt1nope' }, charlie] },
          10,
        ),
      ),
      /not decodable/,
    );
  });

  it('rejects EXPENSE_SUBMITTED with a wrong invoice amount, asset, description or expiry', () => {
    const log = tripLog();
    const body = expenseBody(log, dinnerSpec, 10);
    const [bob, charlie] = body.lines;
    if (!bob || !charlie) throw new Error('lines');
    const base = {
      payee: NODE(KEY.alice),
      cents: 309n,
      description: 'kitty:vietnam-2026:dinner:bob',
      expiresAtS: 3600,
    };
    const send = (bolt11: string) =>
      log.check(
        log.build(
          'EXPENSE_SUBMITTED',
          KEY.alice,
          { ...body, lines: [{ ...bob, bolt11 }, charlie] },
          10,
        ),
      );
    rejected(send(log.invoice({ ...base, cents: 300n })), /not for 309 cents/);
    rejected(send(log.invoice({ ...base, assetId: 'rgb:other' })), /trip asset/);
    rejected(send(log.invoice({ ...base, assetId: null })), /trip asset/);
    rejected(
      send(log.invoice({ ...base, description: 'kitty:vietnam-2026:dinner:charlie' })),
      /description/,
    );
    rejected(send(log.invoice({ ...base, expiresAtS: 10 })), /expired/);
    rejected(send(charlie.bolt11), /not for 309 cents/); // charlie's invoice on bob's line
    expect(send(log.invoice(base))).toEqual({ ok: true });
  });

  it('rejects LINE_SEEN / LINE_DECIDED from someone who is not a debtor, or with wrong cents', () => {
    const log = tripLog();
    const expense = submit(log, dinnerSpec, 10);
    const ref = { expenseEventHash: expense.hash };
    rejected(log.check(log.build('LINE_SEEN', KEY.alice, ref, 11)), /not a debtor/);
    rejected(
      log.check(log.build('LINE_SEEN', KEY.bob, { expenseEventHash: hex('e') }, 11)),
      /unknown expense/,
    );
    log.push('LINE_SEEN', KEY.bob, ref, 11);
    rejected(log.check(log.build('LINE_SEEN', KEY.bob, ref, 12)), /already seen/);
    rejected(
      log.check(
        log.build('LINE_DECIDED', KEY.alice, { ...ref, decision: 'approve', cents: 309n }, 12),
      ),
      /not a debtor/,
    );
    rejected(
      log.check(
        log.build('LINE_DECIDED', KEY.bob, { ...ref, decision: 'approve', cents: 300n }, 12),
      ),
      /cents 300 are not the line's 309/,
    );
    rejected(
      log.check(
        log.build('LINE_DECIDED', KEY.bob, { ...ref, decision: 'contest', cents: 309n }, 12),
      ),
      /needs a reason/,
    );
    // After silent assent (t = 31) the line is due: no contest any more.
    rejected(
      log.check(
        log.build(
          'LINE_DECIDED',
          KEY.bob,
          { ...ref, decision: 'contest', cents: 309n, reason: 'late' },
          31,
        ),
      ),
      /due line cannot be contested/,
    );
    rejected(
      log.check(
        log.build('LINE_DECIDED', KEY.bob, { ...ref, decision: 'approve', cents: 309n }, 31),
      ),
      /due line cannot be approved/,
    );
  });

  it('accepts the explicit approval of an upheld line, once', () => {
    const { log, expense } = dinnerSeen();
    const ref = { expenseEventHash: expense.hash };
    log.push(
      'LINE_DECIDED',
      KEY.charlie,
      { ...ref, decision: 'contest', cents: 350n, reason: 'x' },
      15,
    );
    log.push(
      'DISPUTE_RESOLVED',
      KEY.dave,
      { ...ref, debtorPubkey: KEY.charlie, outcome: 'upheld', note: 'ok' },
      40,
    );
    rejected(
      log.check(
        log.build(
          'DISPUTE_RESOLVED',
          KEY.dave,
          { ...ref, debtorPubkey: KEY.charlie, outcome: 'upheld', note: 'ok' },
          41,
        ),
      ),
      /not contested/,
    );
    const approve = log.build(
      'LINE_DECIDED',
      KEY.charlie,
      { ...ref, decision: 'approve', cents: 350n },
      41,
    );
    expect(log.check(approve)).toEqual({ ok: true });
    log.events.push(approve);
    rejected(
      log.check(
        log.build('LINE_DECIDED', KEY.charlie, { ...ref, decision: 'approve', cents: 350n }, 42),
      ),
      /cannot be approved/,
    );
  });

  it('rejects PAYMENT_MADE / GUARANTEE_PAID with a wrong preimage or amount', () => {
    const { log, expense } = dinnerSeen();
    const good = payBody(log, expense, 0, KEY.alice);
    const send = (b: EventBody<'PAYMENT_MADE'>) =>
      log.check(log.build('PAYMENT_MADE', KEY.bob, b, 20));
    rejected(send({ ...good, preimage: hex('2') }), /preimage does not match/);
    rejected(send({ ...good, paymentHash: hex('1') }), /paymentHash is not the one/);
    rejected(send({ ...good, cents: 300n }), /cents 300/);
    rejected(send({ ...good, creditorPubkey: KEY.charlie }), /creditor/);
    rejected(log.check(log.build('PAYMENT_MADE', KEY.alice, good, 20)), /not a debtor/);
    expect(send(good)).toEqual({ ok: true });

    // charlie overdue at 41 (seen at 11 + 30 s).
    const l = lineOf(expense, 1);
    const cover = {
      expenseEventHash: expense.hash,
      debtorPubkey: KEY.charlie,
      creditorPubkey: KEY.alice,
      cents: l.cents,
      ...log.proof(l.bolt11),
    };
    const guarantee = (b: EventBody<'GUARANTEE_PAID'>, s = 45) =>
      log.check(log.build('GUARANTEE_PAID', KEY.dave, b, s));
    rejected(guarantee(cover, 40), /only an overdue line/);
    rejected(guarantee({ ...cover, preimage: hex('2') }), /preimage does not match/);
    rejected(guarantee({ ...cover, cents: 349n }), /cents 349/);
    expect(guarantee(cover)).toEqual({ ok: true });
  });

  it('rejects a payment on a line already settled', () => {
    const { log, expense } = dinnerSeen();
    log.push('PAYMENT_MADE', KEY.bob, payBody(log, expense, 0, KEY.alice), 20);
    rejected(
      log.check(log.build('PAYMENT_MADE', KEY.bob, payBody(log, expense, 0, KEY.alice), 21)),
      /already paid/,
    );
  });

  it('rejects GUARANTEE_PAID over the guarantee cap G', () => {
    const log = tripLog();
    // A big dinner: charlie owes more than G = 50.00.
    const big: Receipt = {
      ...dinner,
      items: [{ label: 'Banquet', quantity: 1, unitPrice: 2_635_000n, total: 2_635_000n }],
      subtotal: undefined,
      tip: undefined,
      total: 2_635_000n,
    };
    const expense = submit(
      log,
      {
        payer: KEY.alice,
        receipt: big,
        payerItemIndexes: [],
        debtors: [{ id: KEY.charlie, itemIndexes: [0] }],
      },
      10,
    );
    log.push('LINE_SEEN', KEY.charlie, { expenseEventHash: expense.hash }, 11);
    const l = lineOf(expense, 0);
    expect(l.cents).toBe(10_000n);
    rejected(
      log.check(
        log.build(
          'GUARANTEE_PAID',
          KEY.dave,
          {
            expenseEventHash: expense.hash,
            debtorPubkey: KEY.charlie,
            creditorPubkey: KEY.alice,
            cents: l.cents,
            ...log.proof(l.bolt11),
          },
          60,
        ),
      ),
      /over the guarantee cap for charlie/,
    );
  });

  it('rejects EXPENSE_VOIDED by someone else or after a payment', () => {
    const { log, expense } = dinnerSeen();
    const ref = { expenseEventHash: expense.hash };
    rejected(log.check(log.build('EXPENSE_VOIDED', KEY.bob, ref, 12)), /only the payer/);
    log.push('PAYMENT_MADE', KEY.bob, payBody(log, expense, 0, KEY.alice), 20);
    rejected(log.check(log.build('EXPENSE_VOIDED', KEY.alice, ref, 21)), /already paid/);
  });

  it('rejects INVOICE_REISSUED before the current invoice expires', () => {
    const { log, expense } = dinnerSeen();
    const fresh = log.invoice({
      payee: NODE(KEY.alice),
      cents: 309n,
      description: 'kitty:vietnam-2026:dinner:bob',
      expiresAtS: 9000,
    });
    const body = { expenseEventHash: expense.hash, debtorPubkey: KEY.bob, bolt11: fresh };
    rejected(log.check(log.build('INVOICE_REISSUED', KEY.alice, body, 20)), /has not expired/);
    rejected(log.check(log.build('INVOICE_REISSUED', KEY.bob, body, 3700)), /only the payer/);
    expect(log.check(log.build('INVOICE_REISSUED', KEY.alice, body, 3700))).toEqual({ ok: true });
  });

  it('rejects TRIP_CLOSED with open lines, and anything but a checkpoint after it', () => {
    const { log } = dinnerSeen();
    rejected(log.check(log.build('TRIP_CLOSED', KEY.dave, { summary: '' }, 20)), /open lines/);
    const empty = tripLog();
    empty.push('TRIP_CLOSED', KEY.dave, { summary: '' }, 1);
    rejected(
      empty.check(empty.build('POLICY_UPDATED', KEY.bob, { policy: DEFAULT_POLICY }, 2)),
      /trip is closed/,
    );
    rejected(
      empty.check(empty.build('CHECKPOINT', KEY.bob, { seq: 99, headHash: hex('0') }, 2)),
      /not in the log/,
    );
  });

  it('never throws: an exception from the injected decoder is a rejection', () => {
    const log = tripLog();
    const e = log.build('EXPENSE_SUBMITTED', KEY.alice, expenseBody(log, dinnerSpec, 10), 10);
    const trip = deriveTrip(log.events, at(10));
    const r = validateEvent(e, trip, {
      verify: testVerifier,
      decodeInvoice: () => {
        throw new Error('boom');
      },
    });
    rejected(r, /not decodable: Error: boom/);
  });
});

describe('A3 decideAutoPay (SPEC §8)', () => {
  const usd = (cents: bigint): Receipt => ({
    merchant: 'Shop',
    date: '2026-10-17',
    currency: 'USD',
    items: [{ label: 'Thing', quantity: 1, unitPrice: cents, total: cents }],
    total: cents,
    warnings: [],
  });
  /** alice pays `total` USD cents shared with bob only: bob owes total / 2. */
  const shared = (log: Log, total: bigint, expenseId: string, s: number) =>
    submit(
      log,
      {
        payer: KEY.alice,
        receipt: usd(total),
        payerItemIndexes: [0],
        debtors: [{ id: KEY.bob, itemIndexes: [0] }],
        expenseId,
        rate: '1',
      },
      s,
    );
  const bobLine = (log: Log, expense: StoredEvent, s: number) => {
    const trip = deriveTrip(log.events, at(s));
    const line = trip?.lines.get(lineKey(expense.hash, KEY.bob));
    if (!trip || !line) throw new Error('no line');
    return { trip, line, invoice: log.invoices.get(line.bolt11) ?? null };
  };
  const decide = (
    log: Log,
    expense: StoredEvent,
    s: number,
    policy: Policy = DEFAULT_POLICY,
    invoice?: DecodedInvoice | null,
  ) => {
    const { trip, line, invoice: own } = bobLine(log, expense, s);
    return decideAutoPay(policy, line, trip, at(s), invoice === undefined ? own : invoice);
  };
  const payBob = (log: Log, expense: StoredEvent, s: number) => {
    const l = bodyOf(expense).lines[0];
    if (!l) throw new Error('no line');
    log.push(
      'PAYMENT_MADE',
      KEY.bob,
      {
        expenseEventHash: expense.hash,
        creditorPubkey: KEY.alice,
        cents: l.cents,
        rail: 'ln',
        ...log.proof(l.bolt11),
      },
      s,
    );
  };
  const seenBy = (log: Log, expense: StoredEvent, s: number) =>
    log.push('LINE_SEEN', KEY.bob, { expenseEventHash: expense.hash }, s);
  /** The demo dinner, seen by bob at t = 11: silent assent ends at 31. */
  const dinnerForBob = () => {
    const log = tripLog();
    const expense = submit(log, dinnerSpec, 10);
    seenBy(log, expense, 11);
    return { log, expense };
  };

  it('pays a due line under the limit, with the reason sentence', () => {
    const { log, expense } = dinnerForBob();
    expect(decide(log, expense, 31)).toEqual({
      pay: true,
      reason:
        'Paying 3.09 to alice automatically: no objection in 20 s, under your limit of 20.00.',
    });
    payBob(log, expense, 32);
    expect(decide(log, expense, 33)).toEqual({
      pay: false,
      reason: 'Paid 3.09 to alice automatically: no objection in 20 s, under your limit of 20.00.',
    });
  });

  it('explains every state it does not pay', () => {
    const { log, expense } = dinnerForBob();
    expect(decide(log, expense, 23).reason).toBe(
      'Will pay 3.09 to alice in 8 s unless you object.',
    );
    expect(decide(log, expense, 41).reason).toMatch(/^Overdue: .*Pay 3.09 to alice yourself/);
    const fresh = tripLog();
    const unseen = submit(fresh, dinnerSpec, 10);
    expect(decide(fresh, unseen, 11)).toEqual({
      pay: false,
      reason: 'Not seen by your agent yet.',
    });
    fresh.push('EXPENSE_VOIDED', KEY.alice, { expenseEventHash: unseen.hash }, 12);
    expect(decide(fresh, unseen, 13).reason).toMatch(/^Voided/);
  });

  it('does not pay above autoPayLimitCents without explicit approval', () => {
    const log = tripLog();
    const big = shared(log, 9000n, 'boat', 10); // bob owes 45.00
    seenBy(log, big, 11);
    expect(decide(log, big, 12)).toEqual({
      pay: false,
      reason: 'Needs your approval: 45.00 is above your automatic limit of 20.00.',
    });
    expect(decide(log, big, 31)).toEqual({
      pay: false,
      reason: 'Not paid: 45.00 is above your automatic limit of 20.00. Approve it yourself.',
    });
    // The limit is checked again when paying: lowered after silent assent, no payment.
    const { log: l2, expense } = dinnerForBob();
    const lowered = { ...DEFAULT_POLICY, autoPayLimitCents: 100n };
    expect(decide(l2, expense, 31, lowered)).toEqual({
      pay: false,
      reason: 'Not paid: 3.09 is above your automatic limit of 1.00. Approve it yourself.',
    });
  });

  it('pays an explicitly approved line above the limit', () => {
    const log = tripLog();
    const big = shared(log, 9000n, 'boat', 10);
    seenBy(log, big, 11);
    log.push(
      'LINE_DECIDED',
      KEY.bob,
      { expenseEventHash: big.hash, decision: 'approve', cents: 4500n },
      12,
    );
    expect(decide(log, big, 13)).toEqual({
      pay: true,
      reason: 'Paying 45.00 to alice: you approved it.',
    });
    payBob(log, big, 14);
    expect(decide(log, big, 15).reason).toBe('Paid 45.00 to alice: you approved it.');
  });

  it('respects dailyCapCents over a rolling 24 h', () => {
    const log = tripLog();
    // Two automatic payments of 20.00 at t = 31 and t = 61.
    for (const [id, s] of [
      ['e1', 10],
      ['e2', 40],
    ] as const) {
      const e = shared(log, 4000n, id, s);
      seenBy(log, e, s + 1);
      payBob(log, e, s + 21);
    }
    const third = shared(log, 4000n, 'e3', 70);
    seenBy(log, third, 71);
    // 40.00 + 20.00 = 60.00: exactly the cap, paid.
    expect(decide(log, third, 91).pay).toBe(true);
    expect(decide(log, third, 91, { ...DEFAULT_POLICY, dailyCapCents: 5999n })).toEqual({
      pay: false,
      reason:
        'Not paid: 20.00 more would exceed your daily cap of 59.99 (40.00 paid automatically in the last 24 h). Approve it yourself.',
    });
    // Rolling window: a payment exactly 24 h old no longer counts.
    const { trip } = bobLine(log, third, 91);
    expect(autoPaidLast24h(trip, KEY.bob, at(31 + 86_399))).toBe(4000n);
    expect(autoPaidLast24h(trip, KEY.bob, at(31 + 86_400))).toBe(2000n);
    expect(autoPaidLast24h(trip, KEY.bob, at(61 + 86_400))).toBe(0n);
    // An explicit approval is not an automatic payment: no cap.
    log.push(
      'LINE_DECIDED',
      KEY.bob,
      { expenseEventHash: third.hash, decision: 'approve', cents: 2000n },
      92,
    );
    expect(decide(log, third, 93, { ...DEFAULT_POLICY, dailyCapCents: 0n }).pay).toBe(true);
  });

  it('never pays a contested line', () => {
    const { log, expense } = dinnerForBob();
    log.push(
      'LINE_DECIDED',
      KEY.bob,
      { expenseEventHash: expense.hash, decision: 'contest', cents: 309n, reason: 'no pho' },
      12,
    );
    expect(decide(log, expense, 100)).toEqual({
      pay: false,
      reason: 'You contested this line: waiting for dave to decide.',
    });
  });

  it('upheld dispute: pays only with payUpheldDisputes', () => {
    const { log, expense } = dinnerForBob();
    const ref = { expenseEventHash: expense.hash };
    log.push(
      'LINE_DECIDED',
      KEY.bob,
      { ...ref, decision: 'contest', cents: 309n, reason: 'x' },
      12,
    );
    log.push(
      'DISPUTE_RESOLVED',
      KEY.dave,
      { ...ref, debtorPubkey: KEY.bob, outcome: 'upheld', note: 'photo checked' },
      20,
    );
    expect(decide(log, expense, 21)).toEqual({
      pay: false,
      reason:
        "Dave upheld alice's expense: approve 3.09 yourself (your agent does not pay upheld disputes).",
    });
    expect(decide(log, expense, 21, { ...DEFAULT_POLICY, payUpheldDisputes: true })).toEqual({
      pay: true,
      reason:
        'Paying 3.09 to alice automatically: dave upheld the expense and you let your agent pay upheld disputes.',
    });
    log.push('LINE_DECIDED', KEY.bob, { ...ref, decision: 'approve', cents: 309n }, 22);
    expect(decide(log, expense, 23).pay).toBe(true);
  });

  it('upheld, then overdue: pays late once the debtor approves it (SPEC §7, overdue → paid)', () => {
    const { log, expense } = dinnerForBob();
    const ref = { expenseEventHash: expense.hash };
    log.push(
      'LINE_DECIDED',
      KEY.bob,
      { ...ref, decision: 'contest', cents: 309n, reason: 'x' },
      12,
    );
    log.push(
      'DISPUTE_RESOLVED',
      KEY.dave,
      { ...ref, debtorPubkey: KEY.bob, outcome: 'upheld', note: 'photo checked' },
      20,
    );
    // past the new deadline (20 + 30 s) without an approval: overdue, waiting for bob
    expect(bobLine(log, expense, 51).line.state).toBe('overdue');
    expect(decide(log, expense, 51)).toEqual({
      pay: false,
      reason:
        'Overdue: the payment deadline has passed. Approve 3.09 to pay alice now, or the operator will cover it.',
    });
    log.push('LINE_DECIDED', KEY.bob, { ...ref, decision: 'approve', cents: 309n }, 55);
    expect(bobLine(log, expense, 56).line).toMatchObject({
      state: 'overdue',
      approvedExplicitly: true,
    });
    expect(decide(log, expense, 56)).toEqual({
      pay: true,
      reason: 'Paying 3.09 to alice: you approved it.',
    });
  });

  it('an overdue line never approved is not paid by the agent', () => {
    const { log, expense } = dinnerForBob();
    // no approval: silent assent made it due, then the deadline passed (e.g. a failed payment)
    expect(bobLine(log, expense, 50).line.state).toBe('overdue');
    expect(decide(log, expense, 50).pay).toBe(false);
  });

  it('never pays when the invoice payee is not the creditor node, or amount/asset differ', () => {
    const { log, expense } = dinnerForBob();
    const { invoice } = bobLine(log, expense, 31);
    if (!invoice) throw new Error('no invoice');
    const with_ = (patch: Partial<DecodedInvoice>) =>
      decide(log, expense, 31, DEFAULT_POLICY, { ...invoice, ...patch });
    expect(with_({ payeePubkey: NODE(hex('9')) })).toEqual({
      pay: false,
      reason: "Not paid: the invoice is not payable to alice's node.",
    });
    expect(with_({ cents: 310n }).reason).toBe('Not paid: the invoice is not for 3.09 DUSD.');
    expect(with_({ assetId: 'rgb:other' }).reason).toBe(
      'Not paid: the invoice is not for 3.09 DUSD.',
    );
    expect(with_({ assetId: null }).pay).toBe(false);
    expect(with_({ bolt11: 'lnbcrt1other' }).reason).toMatch(/not the one signed in the log/);
    expect(with_({ expiresAt: at(31).toISOString() })).toEqual({
      pay: false,
      reason: 'The invoice from alice has expired: waiting for a new one.',
    });
    expect(decide(log, expense, 31, DEFAULT_POLICY, null).reason).toMatch(
      /could not read the invoice/,
    );
    expect(with_({}).pay).toBe(true);
  });

  it('never pays a creditor who has left, nor when the debtor was excluded', () => {
    const { log, expense } = dinnerForBob();
    log.push(
      'MEMBER_EXCLUDED',
      KEY.dave,
      { memberPubkey: KEY.alice, reason: 'x', closingTxids: [] },
      31,
    );
    expect(decide(log, expense, 32)).toEqual({
      pay: false,
      reason: 'alice has left the trip: pay 3.09 on-chain.',
    });
    const other = dinnerForBob();
    other.log.push(
      'MEMBER_EXCLUDED',
      KEY.dave,
      { memberPubkey: KEY.bob, reason: 'x', closingTxids: [] },
      12,
    );
    expect(decide(other.log, other.expense, 32).pay).toBe(false);
  });

  it('never pays on a closed trip', () => {
    const { log, expense } = dinnerForBob();
    // validateEvent refuses TRIP_CLOSED with open lines; decideAutoPay does not rely on it.
    log.push('TRIP_CLOSED', KEY.dave, { summary: 'early' }, 30);
    expect(decide(log, expense, 31)).toEqual({
      pay: false,
      reason: 'The trip is closed: your agent pays nothing any more.',
    });
  });
});

describe('A7 liquidityPlan (SPEC §10.5)', () => {
  const need = (trip: TripState | null, who: string) => {
    const n = trip && liquidityPlan(trip, 500n).find((x) => x.memberPubkey === who);
    if (!n) throw new Error('no entry');
    return n;
  };
  const lnPay = (log: Log, expense: StoredEvent, i: number, s: number) => {
    const l = bodyOf(expense).lines[i];
    if (!l) throw new Error('no line');
    log.push(
      'PAYMENT_MADE',
      l.debtorPubkey,
      {
        expenseEventHash: expense.hash,
        creditorPubkey: expense.signed.inner.author,
        cents: l.cents,
        rail: 'ln',
        ...log.proof(l.bolt11),
      },
      s,
    );
  };
  const dinnerLog = () => {
    const log = tripLog();
    const expense = submit(log, dinnerSpec, 10);
    return { log, expense };
  };

  it('inbound = L + sent − received', () => {
    const { log, expense } = dinnerLog();
    lnPay(log, expense, 0, 20); // bob → alice 3.09
    const trip = deriveTrip(log.events, at(21));
    // bob paid: dave's side of bob's trip channel grew, bob can receive more.
    expect(need(trip, KEY.bob)).toMatchObject({ inboundCents: 3309n, toReceiveCents: 0n });
    expect(need(trip, KEY.alice)).toMatchObject({ inboundCents: 2691n, toReceiveCents: 350n });
    expect(need(trip, KEY.charlie).inboundCents).toBe(3000n);
  });

  it('open lines in favour of m reduce the margin', () => {
    const { log, expense } = dinnerLog();
    log.push('LINE_SEEN', KEY.charlie, { expenseEventHash: expense.hash }, 11);
    log.push(
      'LINE_DECIDED',
      KEY.charlie,
      { expenseEventHash: expense.hash, decision: 'contest', cents: 350n, reason: 'water only' },
      12,
    );
    // The demo dinner: alice can still receive both lines, the contested one included.
    expect(need(deriveTrip(log.events, at(13)), KEY.alice)).toEqual({
      memberPubkey: KEY.alice,
      inboundCents: 3000n,
      toReceiveCents: 659n,
      marginCents: 2341n,
      openCents: 0n,
    });
    // A voided line no longer needs room.
    log.push(
      'DISPUTE_RESOLVED',
      KEY.dave,
      {
        expenseEventHash: expense.hash,
        debtorPubkey: KEY.charlie,
        outcome: 'line_voided',
        note: '',
      },
      14,
    );
    expect(need(deriveTrip(log.events, at(15)), KEY.alice).toReceiveCents).toBe(309n);
  });

  it('guarantee payments count as received', () => {
    const { log, expense } = dinnerLog();
    const l = bodyOf(expense).lines[1];
    if (!l) throw new Error('no line');
    log.push(
      'MEMBER_EXCLUDED',
      KEY.dave,
      { memberPubkey: KEY.charlie, reason: 'x', closingTxids: [] },
      20,
    );
    log.push(
      'GUARANTEE_PAID',
      KEY.dave,
      {
        expenseEventHash: expense.hash,
        debtorPubkey: KEY.charlie,
        creditorPubkey: KEY.alice,
        cents: l.cents,
        ...log.proof(l.bolt11),
      },
      21,
    );
    expect(need(deriveTrip(log.events, at(22)), KEY.alice)).toMatchObject({
      inboundCents: 2650n,
      toReceiveCents: 309n,
    });
  });

  it('on-chain payments leave the channels alone', () => {
    const { log, expense } = dinnerLog();
    log.push(
      'PAYMENT_MADE',
      KEY.bob,
      {
        expenseEventHash: expense.hash,
        creditorPubkey: KEY.alice,
        cents: 309n,
        rail: 'onchain',
        txid: hex('5'),
      },
      20,
    );
    const trip = deriveTrip(log.events, at(21));
    expect(need(trip, KEY.alice)).toMatchObject({ inboundCents: 3000n, toReceiveCents: 350n });
    expect(need(trip, KEY.bob).inboundCents).toBe(3000n);
  });

  it('opens threshold − margin when margin < threshold', () => {
    const log = tripLog();
    // alice pays 90.00 shared with bob: she must be able to receive 45.00, L is 30.00.
    submit(
      log,
      {
        payer: KEY.alice,
        receipt: {
          merchant: 'Boat',
          date: '2026-10-17',
          currency: 'USD',
          items: [{ label: 'Boat', quantity: 1, unitPrice: 9000n, total: 9000n }],
          total: 9000n,
          warnings: [],
        },
        payerItemIndexes: [0],
        debtors: [{ id: KEY.bob, itemIndexes: [0] }],
        expenseId: 'boat',
        rate: '1',
      },
      10,
    );
    const trip = deriveTrip(log.events, at(11));
    if (!trip) throw new Error('no trip');
    expect(need(trip, KEY.alice)).toEqual({
      memberPubkey: KEY.alice,
      inboundCents: 3000n,
      toReceiveCents: 4500n,
      marginCents: -1500n,
      openCents: 2000n,
    });
    // After dave opened those 20.00 the margin is exactly the threshold: nothing more to open.
    const after = liquidityPlan(trip, 500n, new Map([[KEY.alice, 2000n]]));
    expect(after.find((n) => n.memberPubkey === KEY.alice)).toMatchObject({
      inboundCents: 5000n,
      marginCents: 500n,
      openCents: 0n,
    });
    // Margin above the threshold: nothing to open.
    expect(need(trip, KEY.bob).openCents).toBe(0n);
  });

  it('excluded members need no liquidity, nor members without channels', () => {
    const log = tripLog();
    log.push(
      'MEMBER_EXCLUDED',
      KEY.dave,
      { memberPubkey: KEY.charlie, reason: 'x', closingTxids: [] },
      5,
    );
    const trip = deriveTrip(log.events, at(6));
    if (!trip) throw new Error('no trip');
    expect(liquidityPlan(trip, 500n).map((n) => n.memberPubkey)).toEqual([KEY.alice, KEY.bob]);

    const fresh = new Log();
    fresh.events.push(...tripLog().events.slice(0, 4)); // trip, rate, alice joined and admitted
    const early = deriveTrip(fresh.events, at(1));
    if (!early) throw new Error('no trip');
    expect(liquidityPlan(early, 500n)).toEqual([]);
  });
});
