import { describe, expect, it } from 'vitest';
import {
  LedgerError,
  decideAutoPay,
  deriveTrip,
  liquidityPlan,
  validateEvent,
} from '../src/index.js';

// The checklist of stream A (PLAN.md §4, tasks A1-A3, A7). Turn each it.todo into a test,
// in this order. Reference numbers: the dinner of SPEC §15-16 (3.09 / 3.09 / 3.50).

describe('stubs', () => {
  it('throw NOT_IMPLEMENTED until their task lands', () => {
    const calls = [
      () => deriveTrip([], new Date(0)),
      () => validateEvent({} as never, null, {} as never),
      () => decideAutoPay({} as never, {} as never, {} as never, new Date(0)),
      () => liquidityPlan({} as never, 0n),
    ];
    for (const call of calls) expect(call).toThrow(LedgerError);
  });
});

describe('A1 deriveTrip (SPEC §7)', () => {
  it.todo('EXPENSE_SUBMITTED creates one line per debtor in `submitted`; none for the payer');
  it.todo('LINE_SEEN → awaiting_decision with deadline seenAt + silentAssentSeconds');
  it.todo('silent assent: before the deadline still awaiting_decision');
  it.todo('silent assent: exactly at the deadline → due (within policy)');
  it.todo('silent assent: after the deadline → due (within policy)');
  it.todo('silent assent above autoPayLimitCents → awaiting_explicit, not due');
  it.todo(
    'awaiting_explicit unpaid past seenAt + paymentDeadlineSeconds → overdue (before / exactly / after)',
  );
  it.todo('LINE_DECIDED approve → due; contest → contested with reason');
  it.todo(
    'DISPUTE_RESOLVED upheld → due with a new deadline; line_voided → voided; expense_voided → every line voided',
  );
  it.todo('due unpaid past the deadline → overdue');
  it.todo('PAYMENT_MADE → paid (also from overdue: late payment)');
  it.todo('GUARANTEE_PAID → guaranteed; guaranteeUsedCents grows for the debtor');
  it.todo('EXPENSE_VOIDED → every line voided');
  it.todo('INVOICE_REISSUED replaces the line invoice');
  it.todo('MEMBER_EXCLUDED → member excluded, their open lines overdue at once');
  it.todo('owed and to-receive totals per member; defaults list for dave');
  it.todo('the demo dinner: alice is owed 3.09 by bob and 3.50 by charlie');
  it.todo('property (fast-check): Σ lines + payerCents = totalUsdCents for every expense');
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
