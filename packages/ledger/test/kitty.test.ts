import fc from 'fast-check';
import { DEFAULT_POLICY, type EventBody, type Receipt, type StoredEvent } from '@kitty/shared';
import { describe, expect, it } from 'vitest';
import {
  LedgerError,
  decideAutoPay,
  deriveTrip,
  expenseShares,
  lineKey,
  liquidityPlan,
  validateEvent,
  type TripState,
} from '../src/index.js';
import { KEY, Log, at, dinner, dinnerSpec, hex, submit, tripLog } from './helpers.js';

// The checklist of stream A (PLAN.md §4, tasks A1-A3, A7). Turn each it.todo into a test,
// in this order. Reference numbers: the dinner of SPEC §15-16 (3.09 / 3.09 / 3.50).

describe('stubs', () => {
  it('throw NOT_IMPLEMENTED until their task lands', () => {
    const calls = [
      () => validateEvent({} as never, null, {} as never),
      () => decideAutoPay({} as never, {} as never, {} as never, new Date(0)),
      () => liquidityPlan({} as never, 0n),
    ];
    for (const call of calls) expect(call).toThrow(LedgerError);
  });
});

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
    expect(trip.fingerprints.has(hex('8'))).toBe(true);
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
    expect(ev.fingerprints.has(hex('8'))).toBe(false);
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
    expect(trip.fingerprints.has(hex('8'))).toBe(false);
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
    expect(line(trip, expense, KEY.charlie).bolt11).toBe('lnbcrt1dinner1');
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
        fingerprint: hex('6'),
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
  it.todo('accepts a valid event of every type');
  it.todo('rejects a bad signature (injected verifier)');
  it.todo('rejects a duplicate nonce (replay)');
  it.todo('rejects a broken chain: wrong seq, wrong prevHash, wrong hash');
  it.todo('rejects a coordinator type signed by someone else');
  it.todo('rejects an author not admitted (except TRIP_CREATED, MEMBER_JOINED)');
  it.todo('rejects a MEMBER_JOINED whose bind invoice is from another node');
  it.todo('rejects EXPENSE_SUBMITTED with a duplicate fingerprint');
  it.todo('rejects EXPENSE_SUBMITTED whose totals do not add up (receipt or USD)');
  it.todo('rejects EXPENSE_SUBMITTED with an excluded debtor');
  it.todo('rejects EXPENSE_SUBMITTED with an invoice payable to another node');
  it.todo('rejects EXPENSE_SUBMITTED with a wrong invoice amount or asset');
  it.todo('rejects LINE_SEEN / LINE_DECIDED from someone who is not a debtor, or with wrong cents');
  it.todo('rejects PAYMENT_MADE / GUARANTEE_PAID with a wrong preimage or amount');
});

describe('A3 decideAutoPay (SPEC §8)', () => {
  it.todo('pays a due line under the limit, with the reason sentence');
  it.todo('does not pay above autoPayLimitCents without explicit approval');
  it.todo('pays an explicitly approved line above the limit');
  it.todo('respects dailyCapCents over a rolling 24 h');
  it.todo('never pays a contested line');
  it.todo('upheld dispute: pays only with payUpheldDisputes');
  it.todo('never pays when the invoice payee is not the creditor node, or amount/asset differ');
  it.todo('never pays on a closed trip');
});

describe('A7 liquidityPlan (SPEC §10.5)', () => {
  it.todo('inbound = L + sent − received');
  it.todo('open lines in favour of m reduce the margin');
  it.todo('guarantee payments count as received');
  it.todo('opens toReceive − margin + threshold when margin < threshold');
  it.todo('excluded members need no liquidity');
});
