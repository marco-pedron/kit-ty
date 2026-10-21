import { describe, expect, it } from 'vitest';
import {
  authorHeads,
  duplicateFingerprints,
  effectivePolicy,
  expenseVoided,
  forkedAuthors,
  invoiceToPay,
  isBlocked,
  joinsByInvite,
  lineDecision,
  overpaid,
  paymentMatchesLine,
  settleLine,
} from './conflicts.js';
import { fixedOrder } from './order.js';
import { ev, type TestEvent } from './test/dag.js';

// One test per rule of plan §2.4. "Concurrent" = neither precedes the other.
const [ALICE, BOB, CHARLIE] = ['a', 'b', 'c'].map((x) => x.repeat(64)) as [string, string, string];
const g = ev([], { salt: 'TRIP_CREATED' });
const expense = ev([g.id], { author: ALICE, salt: 'EXPENSE_SUBMITTED' });

function causality(...events: TestEvent[]) {
  return fixedOrder([g, expense, ...events]).causality;
}

describe('C1: approve and contest on the same line, concurrent', () => {
  it('contest wins, whatever the ids', () => {
    const approve = ev([expense.id], { author: BOB, salt: 'approve' });
    const contest = ev([expense.id], { author: BOB, salt: 'contest' });
    const c = causality(approve, contest);
    expect(c.concurrent(approve.id, contest.id)).toBe(true);
    const decisions = [
      { id: approve.id, decision: 'approve' as const },
      { id: contest.id, decision: 'contest' as const },
    ];
    expect(lineDecision(c, decisions)).toBe('contest');
    expect(lineDecision(c, [...decisions].reverse())).toBe('contest');
  });
});

describe('C2: payment and EXPENSE_VOIDED on the same expense', () => {
  it('the payment wins, concurrent or after the void', () => {
    const voided = ev([expense.id], { author: ALICE, salt: 'void' });
    const paidConcurrent = ev([expense.id], { author: BOB, salt: 'paid' });
    const paidAfter = ev([voided.id], { author: BOB, salt: 'paid after' });
    causality(voided, paidConcurrent, paidAfter);
    expect(expenseVoided([voided], [paidConcurrent])).toBe(false);
    expect(expenseVoided([voided], [paidAfter])).toBe(false);
  });

  it('a void without valid payments voids the expense', () => {
    const voided = ev([expense.id], { author: ALICE, salt: 'void' });
    expect(expenseVoided([voided], [])).toBe(true);
    expect(expenseVoided([], [])).toBe(false);
  });
});

describe('C3: the same debtor decides twice in causal sequence', () => {
  it('contest, then approve after seeing it: approve', () => {
    const contest = ev([expense.id], { author: BOB, salt: 'contest' });
    const approve = ev([contest.id], { author: BOB, salt: 'approve' });
    const c = causality(contest, approve);
    expect(
      lineDecision(c, [
        { id: contest.id, decision: 'contest' },
        { id: approve.id, decision: 'approve' },
      ]),
    ).toBe('approve');
  });

  it('approve, then contest: contest', () => {
    const approve = ev([expense.id], { author: BOB, salt: 'approve' });
    const contest = ev([approve.id], { author: BOB, salt: 'contest' });
    const c = causality(approve, contest);
    expect(
      lineDecision(c, [
        { id: approve.id, decision: 'approve' },
        { id: contest.id, decision: 'contest' },
      ]),
    ).toBe('contest');
  });

  it('an approve that did not see the contest does not withdraw it (C1 over C3)', () => {
    const contest = ev([expense.id], { author: BOB, salt: 'contest (phone)' });
    const approve1 = ev([expense.id], { author: BOB, salt: 'approve (tablet)' });
    const approve2 = ev([approve1.id], { author: BOB, salt: 'approve again (tablet)' });
    const c = causality(contest, approve1, approve2);
    expect(
      lineDecision(c, [
        { id: contest.id, decision: 'contest' },
        { id: approve1.id, decision: 'approve' },
        { id: approve2.id, decision: 'approve' },
      ]),
    ).toBe('contest');
  });

  it('no decision: null', () => {
    expect(lineDecision(causality(), [])).toBeNull();
  });
});

describe('C4: two valid payments of the same line', () => {
  it('the first in the fixed order pays, the other is a credit of the debtor', () => {
    const p1 = ev([expense.id], { author: BOB, salt: 'paid (phone)' });
    const p2 = ev([expense.id], { author: BOB, salt: 'paid (tablet)' });
    const c = causality(p1, p2);
    const payments = [
      { id: p1.id, amount: 309n },
      { id: p2.id, amount: 309n },
    ];
    const first = c.position(p1.id) < c.position(p2.id) ? p1.id : p2.id;
    const r = settleLine(c, payments);
    expect(r.paidBy?.id).toBe(first);
    expect(r.overpayments).toHaveLength(1);
    expect(overpaid(r.overpayments)).toBe(309n);
    expect(settleLine(c, [...payments].reverse()).paidBy?.id).toBe(first);
  });

  it('none: the line is not paid', () => {
    expect(settleLine(causality(), [])).toEqual({ paidBy: null, overpayments: [] });
  });
});

describe('C5: PAYMENT_MADE and INVOICE_REISSUED, concurrent', () => {
  it('a payment of the original or of the reissued invoice settles the line', () => {
    const invoices = [{ paymentHash: '01'.repeat(32) }, { paymentHash: '02'.repeat(32) }];
    expect(paymentMatchesLine('01'.repeat(32), invoices)).toBe(true);
    expect(paymentMatchesLine('02'.repeat(32), invoices)).toBe(true);
    expect(paymentMatchesLine('03'.repeat(32), invoices)).toBe(false);
  });
});

describe('C6: two INVOICE_REISSUED of the same line, concurrent', () => {
  it('the debtor pays the unexpired one with the smallest event id', () => {
    const invoices = [
      { eventId: '3'.repeat(64), expiresAt: 2000 },
      { eventId: '1'.repeat(64), expiresAt: 900 },
      { eventId: '2'.repeat(64), expiresAt: 2000 },
    ];
    expect(invoiceToPay(invoices, 1000)?.eventId).toBe('2'.repeat(64));
    expect(invoiceToPay(invoices, 500)?.eventId).toBe('1'.repeat(64));
    expect(invoiceToPay(invoices, 3000)).toBeNull();
  });
});

describe('C7: MEMBER_BLOCKED and MEMBER_UNBLOCKED of the same author on the same member', () => {
  it('concurrent: the block wins', () => {
    const block = ev([g.id], { author: ALICE, salt: 'block charlie' });
    const unblock = ev([g.id], { author: ALICE, salt: 'unblock charlie' });
    const c = causality(block, unblock);
    expect(
      isBlocked(c, [
        { id: block.id, kind: 'block' },
        { id: unblock.id, kind: 'unblock' },
      ]),
    ).toBe(true);
  });

  it('in sequence: the last one counts', () => {
    const block = ev([g.id], { author: ALICE, salt: 'block' });
    const unblock = ev([block.id], { author: ALICE, salt: 'unblock' });
    const reblock = ev([unblock.id], { author: ALICE, salt: 'block again' });
    const c = causality(block, unblock, reblock);
    const seq = [
      { id: block.id, kind: 'block' as const },
      { id: unblock.id, kind: 'unblock' as const },
    ];
    expect(isBlocked(c, seq)).toBe(false);
    expect(isBlocked(c, [...seq, { id: reblock.id, kind: 'block' }])).toBe(true);
    expect(isBlocked(c, [])).toBe(false);
  });
});

describe('C8, C9, C14: need the member states of step 2', () => {
  it.todo(
    'C8: EXPENSE_SUBMITTED concurrent with a MEMBER_BLOCKED that would invalidate it is valid',
  );
  it.todo(
    'C9: EXPENSE_SUBMITTED concurrent with the debtor MEMBER_LEFT: both valid, the debt stays',
  );
  it.todo('C14: MEMBER_INVITED concurrent with the inviter MEMBER_LEFT is valid');
});

describe('C10: two EXPENSE_SUBMITTED with the same fingerprint', () => {
  it('the first in the fixed order is valid; the loser learns who registered it', () => {
    const mine = ev([g.id], { author: ALICE, salt: 'dinner (alice)' });
    const theirs = ev([g.id], { author: BOB, salt: 'dinner (bob)' });
    const again = ev([g.id], { author: ALICE, salt: 'dinner (alice, again)' });
    const c = causality(mine, theirs, again);
    const expenses = [mine, theirs, again].map((e) => ({ ...e, fingerprint: 'f'.repeat(64) }));
    const losers = duplicateFingerprints(c, expenses);
    const [winner, ...rest] = c.sortByOrder([mine.id, theirs.id, again.id]);
    expect(losers.size).toBe(2);
    for (const id of rest) expect(losers.get(id)?.winner).toBe(winner);
    const authorOf = (id: string) => expenses.find((e) => e.id === id)?.author;
    for (const id of rest)
      expect(losers.get(id)?.sameAuthor).toBe(authorOf(id) === authorOf(winner as string));
  });

  it('different fingerprints are not duplicates', () => {
    const a = ev([g.id], { author: ALICE, salt: 'a' });
    const b = ev([g.id], { author: ALICE, salt: 'b' });
    const c = causality(a, b);
    expect(
      duplicateFingerprints(c, [
        { ...a, fingerprint: '1'.repeat(64) },
        { ...b, fingerprint: '2'.repeat(64) },
      ]).size,
    ).toBe(0);
  });
});

describe('C11: EXPENSE_VOIDED concurrent with LINE_DECIDED', () => {
  it('the void wins: decisions do not enter the rule', () => {
    const voided = ev([expense.id], { author: ALICE, salt: 'void' });
    const approve = ev([expense.id], { author: BOB, salt: 'approve' });
    const c = causality(voided, approve);
    expect(c.concurrent(voided.id, approve.id)).toBe(true);
    expect(expenseVoided([voided], [])).toBe(true);
  });
});

describe('C12: two POLICY_UPDATED of the same member, concurrent', () => {
  it('the last in the fixed order', () => {
    const phone = ev([g.id], { author: BOB, salt: 'policy (phone)' });
    const tablet = ev([g.id], { author: BOB, salt: 'policy (tablet)' });
    const c = causality(phone, tablet);
    const last = c.position(phone.id) > c.position(tablet.id) ? phone.id : tablet.id;
    expect(effectivePolicy(c, [phone, tablet])?.id).toBe(last);
    expect(effectivePolicy(c, [tablet, phone])?.id).toBe(last);
    expect(effectivePolicy(c, [])).toBeNull();
  });
});

describe('C13: two MEMBER_JOINED with the same invite', () => {
  it('the first in the fixed order joins, the other is invalid', () => {
    const invite = ev([g.id], { author: ALICE, salt: 'invite' });
    const j1 = ev([invite.id], { author: BOB, salt: 'join bob' });
    const j2 = ev([invite.id], { author: CHARLIE, salt: 'join charlie' });
    const creator = ev([g.id], { author: ALICE, salt: 'join creator' });
    const c = causality(invite, j1, j2, creator);
    const joins = [
      { id: j1.id, inviteRef: invite.id },
      { id: j2.id, inviteRef: invite.id },
      { id: creator.id, inviteRef: null },
    ];
    const first = c.position(j1.id) < c.position(j2.id) ? j1.id : j2.id;
    const r = joinsByInvite(c, joins);
    expect(r.accepted.map((j) => j.id).sort()).toEqual([first, creator.id].sort());
    expect(r.rejected.map((j) => j.id)).toEqual([first === j1.id ? j2.id : j1.id]);
  });
});

describe('C15: the personal chain of an author forks', () => {
  it('both events stay; the author is marked as forked', () => {
    const phone = ev([g.id], { author: BOB, salt: 'phone' });
    const tablet = ev([g.id], { author: BOB, salt: 'tablet' });
    const linear1 = ev([g.id], { author: ALICE, salt: 'alice 1' });
    const linear2 = ev([linear1.id, phone.id], { author: ALICE, salt: 'alice 2' });
    const c = causality(phone, tablet, linear1, linear2);
    const events = [phone, tablet, linear1, linear2];
    expect(forkedAuthors(c, events)).toEqual(new Set([BOB]));
  });

  it('heads of an author as known at an event: a block known to either head counts', () => {
    const block = ev([g.id], { author: CHARLIE, salt: 'block alice' });
    const phone = ev([block.id], { author: BOB, salt: 'phone saw the block' });
    const tablet = ev([g.id], { author: BOB, salt: 'tablet did not' });
    const at = ev([phone.id, tablet.id], { author: ALICE, salt: 'expense' });
    const c = causality(block, phone, tablet, at);
    const heads = authorHeads(c, [block, phone, tablet, at], BOB, at.id);
    expect(new Set(heads)).toEqual(new Set([phone.id, tablet.id]));
    expect(heads.some((h) => c.precedes(block.id, h))).toBe(true);
  });
});
