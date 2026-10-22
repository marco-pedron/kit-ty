import { describe, expect, it } from 'vitest';
import {
  authorHeads,
  duplicateFingerprints,
  effectivePolicy,
  expenseVoided,
  forkedAuthors,
  invoiceToPay,
  lineDecision,
  overpaid,
  paymentMatchesLine,
  settleLine,
} from './conflicts.js';
import { fixedOrder } from './order.js';
import { ev, type TestEvent } from './test/dag.js';

// One test per rule of plan §2.4. "Concurrent" = neither precedes the other.
// [T] = rule of the team document, [I] = our proposal (docs/proposte/regole-conflitto.md).
// [I] rules on an open question (plan §11) are it.todo until the team answers.
const [ALICE, BOB, CHARLIE] = ['a', 'b', 'c'].map((x) => x.repeat(64)) as [string, string, string];
const g = ev([], { salt: 'TRIP_CREATED' });
const expense = ev([g.id], { author: ALICE, salt: 'EXPENSE_SUBMITTED' });

function causality(...events: TestEvent[]) {
  return fixedOrder([g, expense, ...events]).causality;
}

describe('C1 [T]: approve and contest on the same line, concurrent', () => {
  it('contest wins, whatever the ids', () => {
    const approve = ev([expense.id], { author: BOB, salt: 'approve' });
    const contest = ev([expense.id], { author: BOB, salt: 'contest' });
    const c = causality(approve, contest);
    expect(c.concurrent(approve.id, contest.id)).toBe(true);
    const decisions = [
      { id: approve.id, decision: 'approve' as const },
      { id: contest.id, decision: 'contest' as const },
    ];
    expect(lineDecision(decisions)).toBe('contest');
    expect(lineDecision([...decisions].reverse())).toBe('contest');
  });

  it('only approvals: approve; no decision: null', () => {
    expect(lineDecision([{ id: expense.id, decision: 'approve' }])).toBe('approve');
    expect(lineDecision([])).toBeNull();
  });
});

describe('C2 [T]: payment and EXPENSE_VOIDED on the same expense', () => {
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

describe('C3 [I]: the same debtor decides twice in causal sequence (open: D5)', () => {
  it.todo('C3: contest, then approve after seeing it: is the contest withdrawn? (plan §11 D5)');
  it.todo('C3: approve, then contest: does the later contest count? (plan §11 D5)');
});

describe('C4 [I]: two valid payments of the same line', () => {
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

describe('C5 [I]: PAYMENT_MADE and INVOICE_REISSUED, concurrent', () => {
  it('a payment of the original or of the reissued invoice settles the line', () => {
    const invoices = [{ paymentHash: '01'.repeat(32) }, { paymentHash: '02'.repeat(32) }];
    expect(paymentMatchesLine('01'.repeat(32), invoices)).toBe(true);
    expect(paymentMatchesLine('02'.repeat(32), invoices)).toBe(true);
    expect(paymentMatchesLine('03'.repeat(32), invoices)).toBe(false);
  });
});

describe('C6 [I]: two INVOICE_REISSUED of the same line, concurrent', () => {
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

describe('C7 [I]: block and unblock of one author on one member (open: D6)', () => {
  it.todo('C7: concurrent MEMBER_BLOCKED and MEMBER_UNBLOCKED: which wins? (plan §11 D6)');
  it.todo('C7: in causal sequence the last one counts, per pair or for all? (plan §11 D6)');
});

describe('C8 [I], C9 [I]: open questions', () => {
  it.todo(
    'C8: EXPENSE_SUBMITTED concurrent with a MEMBER_BLOCKED: valid if the block was not known? (plan §11 D6)',
  );
  it.todo(
    'C9: EXPENSE_SUBMITTED concurrent with the debtor MEMBER_LEFT: the team allows leaving only without debts (plan §11 D9)',
  );
});

describe('C14 [I]: needs the member states of step 2', () => {
  it.todo('C14: MEMBER_INVITED concurrent with the inviter MEMBER_LEFT is valid');
});

describe('C10 [I]: two EXPENSE_SUBMITTED with the same fingerprint', () => {
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

describe('C11 [I]: EXPENSE_VOIDED concurrent with LINE_DECIDED', () => {
  it('the void wins: decisions do not enter the rule', () => {
    const voided = ev([expense.id], { author: ALICE, salt: 'void' });
    const approve = ev([expense.id], { author: BOB, salt: 'approve' });
    const c = causality(voided, approve);
    expect(c.concurrent(voided.id, approve.id)).toBe(true);
    expect(expenseVoided([voided], [])).toBe(true);
  });
});

describe('C12 [I]: two POLICY_UPDATED of the same member, concurrent', () => {
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

describe('C13 [I]: two MEMBER_JOINED with the same invite (open: D3)', () => {
  it.todo('C13: one invite, one join? Depends on the Sybil answer (plan §11 D3)');
});

describe('C15 [I]: the personal chain of an author forks', () => {
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
