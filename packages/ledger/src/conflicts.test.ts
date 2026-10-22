import { describe, expect, it } from 'vitest';
import {
  authorHeads,
  effectivePolicy,
  forkedAuthors,
  invoiceToPay,
  lineDecision,
  overpaid,
  paymentMatchesLine,
  possibleDuplicates,
  settleLine,
  voidedLines,
} from './conflicts.js';
import { fixedOrder } from './order.js';
import { ev, type TestEvent } from './test/dag.js';

// One test per rule of plan §2.4. "Concurrent" = neither precedes the other.
// All rules decided (docs/proposte/regole-conflitto.md, 22/10): [T] = from the team document,
// [D] = decided by the team on 22/10. Rules that need the member states are it.todo for step 2.
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
    expect(lineDecision(c, decisions)).toBe('contest');
    expect(lineDecision(c, [...decisions].reverse())).toBe('contest');
  });

  it('no decision: null', () => {
    expect(lineDecision(causality(), [])).toBeNull();
  });
});

describe('C2 [T]: payment and EXPENSE_VOIDED on the same expense', () => {
  const lines = [BOB, CHARLIE];

  it('the payment saves only the paid line, concurrent or after the void', () => {
    const voided = ev([expense.id], { author: ALICE, salt: 'void' });
    const paidConcurrent = ev([expense.id], { author: BOB, salt: 'paid' });
    const paidAfter = ev([voided.id], { author: BOB, salt: 'paid after' });
    causality(voided, paidConcurrent, paidAfter);
    expect(voidedLines([voided], lines, new Set([BOB]))).toEqual(new Set([CHARLIE]));
  });

  it('a void without valid payments voids every line; no void, no line voided', () => {
    const voided = ev([expense.id], { author: ALICE, salt: 'void' });
    expect(voidedLines([voided], lines, new Set())).toEqual(new Set(lines));
    expect(voidedLines([], lines, new Set())).toEqual(new Set());
  });

  it('every line paid: nothing is voided', () => {
    const voided = ev([expense.id], { author: ALICE, salt: 'void' });
    expect(voidedLines([voided], lines, new Set(lines))).toEqual(new Set());
  });
});

describe('C3 [D]: the same debtor decides twice in causal sequence', () => {
  it('contest, then approve after seeing it: the contest is withdrawn', () => {
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

  it('an approve withdraws only the contests among its ancestors', () => {
    const seen = ev([expense.id], { author: BOB, salt: 'contest (phone)' });
    const unseen = ev([expense.id], { author: BOB, salt: 'contest (tablet)' });
    const approve = ev([seen.id], { author: BOB, salt: 'approve (phone)' });
    const c = causality(seen, unseen, approve);
    expect(
      lineDecision(c, [
        { id: seen.id, decision: 'contest' },
        { id: unseen.id, decision: 'contest' },
        { id: approve.id, decision: 'approve' },
      ]),
    ).toBe('contest');
  });
});

describe('C4 [D]: two valid payments of the same line', () => {
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

describe('C5 [D]: PAYMENT_MADE and INVOICE_REISSUED, concurrent', () => {
  it('a payment of the original or of the reissued invoice settles the line', () => {
    const invoices = [{ paymentHash: '01'.repeat(32) }, { paymentHash: '02'.repeat(32) }];
    expect(paymentMatchesLine('01'.repeat(32), invoices)).toBe(true);
    expect(paymentMatchesLine('02'.repeat(32), invoices)).toBe(true);
    expect(paymentMatchesLine('03'.repeat(32), invoices)).toBe(false);
  });
});

describe('C6 [D]: two INVOICE_REISSUED of the same line, concurrent', () => {
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

describe('step 2: rules that need the member states', () => {
  it.todo('C7: an unblock is valid only if signed by who blocked');
  it.todo('C7: an unblock removes every block of its author on that member among its ancestors');
  it.todo('C7: concurrent block and unblock: the block wins');
  it.todo('C8 (D6): a block among the ancestors invalidates an expense between payer and debtor');
  it.todo('C9: a debt concurrent with leaving stays, marked "debt after leaving"; contestable');
  it.todo('C13: one invite, one join (first in the fixed order)');
  it.todo('C14: MEMBER_INVITED concurrent with the inviter MEMBER_LEFT is valid');
});

describe('C10 [D]: two EXPENSE_SUBMITTED with the same fingerprint', () => {
  it('all are valid and each is marked as a possible duplicate of the others', () => {
    const mine = ev([g.id], { author: ALICE, salt: 'dinner (alice)' });
    const theirs = ev([g.id], { author: BOB, salt: 'dinner (bob)' });
    const again = ev([g.id], { author: ALICE, salt: 'dinner (alice, again)' });
    const other = ev([g.id], { author: ALICE, salt: 'taxi' });
    const f = 'f'.repeat(64);
    const marked = possibleDuplicates([
      { ...mine, fingerprint: f },
      { ...theirs, fingerprint: f },
      { ...again, fingerprint: f },
      { ...other, fingerprint: '1'.repeat(64) },
    ]);
    expect(new Set(marked.keys())).toEqual(new Set([mine.id, theirs.id, again.id]));
    expect(new Set(marked.get(mine.id))).toEqual(new Set([theirs.id, again.id]));
    expect(marked.has(other.id)).toBe(false);
  });

  it('the arrival order changes nothing', () => {
    const a = { id: '1'.repeat(64), fingerprint: 'f'.repeat(64) };
    const b = { id: '2'.repeat(64), fingerprint: 'f'.repeat(64) };
    expect(possibleDuplicates([a, b])).toEqual(possibleDuplicates([b, a]));
  });
});

describe('C11 [D]: EXPENSE_VOIDED concurrent with LINE_DECIDED', () => {
  it('the void wins over a decision, but not over a paid line (C2)', () => {
    const voided = ev([expense.id], { author: ALICE, salt: 'void' });
    const approve = ev([expense.id], { author: BOB, salt: 'approve' });
    const c = causality(voided, approve);
    expect(c.concurrent(voided.id, approve.id)).toBe(true);
    expect(voidedLines([voided], [BOB, CHARLIE], new Set())).toEqual(new Set([BOB, CHARLIE]));
    expect(voidedLines([voided], [BOB, CHARLIE], new Set([CHARLIE]))).toEqual(new Set([BOB]));
  });
});

describe('C12 [D]: POLICY_UPDATED of the same member', () => {
  const policy = (autoPayLimit: bigint, dailyCap: bigint) => ({ autoPayLimit, dailyCap });

  it('concurrent: the most prudent, field by field', () => {
    const phone = ev([g.id], { author: BOB, salt: 'policy (phone)' });
    const tablet = ev([g.id], { author: BOB, salt: 'policy (tablet)' });
    const c = causality(phone, tablet);
    const updates = [
      { id: phone.id, policy: policy(2000n, 9000n) },
      { id: tablet.id, policy: policy(5000n, 6000n) },
    ];
    expect(effectivePolicy(c, updates)).toEqual(policy(2000n, 6000n));
    expect(effectivePolicy(c, [...updates].reverse())).toEqual(policy(2000n, 6000n));
  });

  it('in causal sequence the later one counts, even if less prudent', () => {
    const first = ev([g.id], { author: BOB, salt: 'policy 1' });
    const second = ev([first.id], { author: BOB, salt: 'policy 2' });
    const c = causality(first, second);
    expect(
      effectivePolicy(c, [
        { id: first.id, policy: policy(1000n, 3000n) },
        { id: second.id, policy: policy(4000n, 8000n) },
      ]),
    ).toEqual(policy(4000n, 8000n));
    expect(effectivePolicy(c, [])).toBeNull();
  });
});

describe('C15 [D]: the personal chain of an author forks', () => {
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
