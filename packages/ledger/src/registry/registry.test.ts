import fc from 'fast-check';
import type { registry as shared } from '@kitty/shared';
import { describe, expect, it } from 'vitest';
import { expenseShares } from '../shares.js';
import { PARAMS, PK, T0, TestTrip, shuffled, type Name } from '../test/registry.js';
import { decideRegistryAutoPay, invoiceRefusal } from './autopay.js';
import { deriveRegistry, type RegistryTrip } from './derive.js';
import { blockWarning, lineKey } from './fold.js';
import { expenseRefusal } from './validate.js';

// Step 2: the registry v2 rules (docs/stack-a-decisioni.md, docs/proposte/regole-conflitto.md).

type Ev = shared.RegistryEvent;
const LATER = T0 + 3_600;

function derive(t: TestTrip, now = LATER): RegistryTrip {
  const trip = deriveRegistry(t.events, t.deps, now);
  if (trip === null) throw new Error('no trip');
  return trip;
}
const reasonOf = (trip: RegistryTrip, e: Ev) => trip.rejected.find((r) => r.id === e.id)?.reason;
const lineOf = (trip: RegistryTrip, expense: Ev, debtor: Name) => {
  const line = trip.lines.get(lineKey(expense.id, PK[debtor]));
  if (line === undefined) throw new Error(`no line of ${debtor}`);
  return line;
};

describe('trip without a coordinator', () => {
  it('the creator joins without an invite, the others with one; nobody has special powers', () => {
    const t = TestTrip.withMembers();
    const trip = derive(t);
    expect(trip.rejected).toEqual([]);
    expect([...trip.members.values()].map((m) => m.displayName).sort()).toEqual([
      'alice',
      'bob',
      'charlie',
    ]);
    expect(trip.members.get(PK.bob)?.invitedBy).toBe(PK.alice);
  });

  it('anyone else needs an invite, and an invite for a key is only for that key', () => {
    const t = TestTrip.withMembers(['bob']);
    const noInvite = t.join('charlie', null);
    const forBob = t.invite('alice', { for: 'bob' });
    const wrongKey = t.join('charlie', forBob);
    const trip = derive(t);
    expect(reasonOf(trip, noInvite)).toMatch(/without an invite/);
    expect(reasonOf(trip, wrongKey)).toMatch(/another key/);
    expect(trip.members.has(PK.charlie)).toBe(false);
  });

  it('an expense whose genesis is missing is not a trip', () => {
    const t = TestTrip.withMembers();
    expect(deriveRegistry(t.events.slice(1), t.deps, LATER)).toBeNull();
  });
});

describe('kitty-bind:v2: the join ties the node to the registry key of this trip', () => {
  it('a bind invoice with another trip tag, another key or from another node is refused', () => {
    const t = TestTrip.withMembers(['bob']);
    const tag = t.join('charlie', t.invite('alice'), {
      bindDescription: `kitty-bind:v2:${'f'.repeat(64)}:${PK.charlie}`,
    });
    const key = t.join('charlie', t.invite('alice'), {
      bindDescription: `kitty-bind:v2:${'e'.repeat(64)}:${PK.bob}`,
    });
    const node = t.join('charlie', t.invite('alice'), { bindNode: `02${'dd'.repeat(32)}` });
    const trip = derive(t);
    expect(reasonOf(trip, tag)).toMatch(/does not commit to this trip and key/);
    expect(reasonOf(trip, key)).toMatch(/does not commit to this trip and key/);
    expect(reasonOf(trip, node)).toMatch(/another node/);
    expect(trip.members.has(PK.charlie)).toBe(false);
  });
});

describe('C13: one invite, one join', () => {
  function twoJoins() {
    const t = TestTrip.withMembers([]);
    const invite = t.invite('alice');
    const bob = t.join('bob', invite, { parents: [invite] });
    const charlie = t.join('charlie', invite, { parents: [invite] });
    return { t, bob, charlie };
  }

  it('two concurrent joins with the same invite: the first in the fixed order joins', () => {
    const { t, bob, charlie } = twoJoins();
    const trip = derive(t);
    const first =
      trip.fold.c.position(bob.id) < trip.fold.c.position(charlie.id) ? 'bob' : 'charlie';
    const second = first === 'bob' ? 'charlie' : 'bob';
    expect(trip.members.has(PK[first])).toBe(true);
    expect(trip.members.has(PK[second])).toBe(false);
    // The loser's own events are not applied either.
    t.add(second, 'POLICY_UPDATED', { policy: { autoPayLimit: 1n, dailyCap: 1n } });
    expect(derive(t).members.has(PK[second])).toBe(false);
  });

  it('a join with an invite already used, once known, is invalid', () => {
    const t = new TestTrip();
    t.join('alice', null);
    const invite = t.invite('alice');
    t.join('bob', invite);
    const reuse = t.join('charlie', invite);
    expect(reasonOf(derive(t), reuse)).toMatch(/one invite, one join/);
  });
});

describe('C14: an invite stays valid if the inviter leaving was not known', () => {
  it('concurrent with the leave: valid; after the leave: invalid', () => {
    const t = TestTrip.withMembers(['bob']);
    const base = t.heads();
    const left = t.add('bob', 'MEMBER_LEFT', {}, { parents: base });
    const concurrent = t.invite('bob', { parents: base });
    const after = t.invite('bob', { parents: [left, concurrent] });
    const trip = derive(t);
    expect(reasonOf(trip, concurrent)).toBeUndefined();
    expect(reasonOf(trip, after)).toMatch(/active member/);
    const charlie = t.join('charlie', concurrent);
    expect(reasonOf(derive(t), charlie)).toBeUndefined();
  });
});

describe('expenses, silent assent and table signatures', () => {
  it('unseen → seen → due after silent assent → paid', () => {
    const t = TestTrip.withMembers();
    const e = t.expense('alice', ['bob', 'charlie']);
    expect(lineOf(derive(t), e, 'bob').state).toBe('submitted');
    t.add('bob', 'LINE_SEEN', { expenseRef: e.id }, { createdAt: T0 + 1_000 });
    expect(lineOf(derive(t, T0 + 1_010), e, 'bob').state).toBe('awaiting_decision');
    expect(lineOf(derive(t, T0 + 1_020), e, 'bob').state).toBe('due');
    t.pay('bob', e);
    const trip = derive(t);
    expect(lineOf(trip, e, 'bob').state).toBe('paid');
    expect(trip.rejected).toEqual([]);
    expect(lineOf(trip, e, 'charlie').state).toBe('submitted');
  });

  it('a line signed at the table is due at once and counts as an explicit approval', () => {
    const t = TestTrip.withMembers();
    const e = t.expense('alice', ['bob', 'charlie'], { signed: ['bob'] });
    const trip = derive(t);
    expect(lineOf(trip, e, 'bob')).toMatchObject({ state: 'due', approvedExplicitly: true });
    expect(lineOf(trip, e, 'charlie').state).toBe('submitted');
    const seen = t.add('bob', 'LINE_SEEN', { expenseRef: e.id });
    expect(reasonOf(derive(t), seen)).toMatch(/signed this line at the table/);
  });

  it('a table signature of a non-debtor, or a wrong one, invalidates the expense', () => {
    const t = TestTrip.withMembers();
    const notDebtor = t.expense('alice', ['bob'], { signed: ['charlie'] });
    const body = t.expenseBody('alice', ['bob'], { signed: ['bob'] });
    const forged = t.add('alice', 'EXPENSE_SUBMITTED', {
      ...body,
      tableSignatures: [{ signer: PK.bob, sig: 'ab'.repeat(64) }],
    });
    const trip = derive(t);
    expect(reasonOf(trip, notDebtor)).toMatch(/not a debtor/);
    expect(reasonOf(trip, forged)).toMatch(/invalid table signature/);
  });

  it('the ledger recomputes every share and checks the invoices (D2)', () => {
    const t = TestTrip.withMembers();
    const ok = t.expenseBody('alice', ['bob']);
    const [line] = ok.proposal.lines;
    const wrongShare = t.add('alice', 'EXPENSE_SUBMITTED', {
      ...ok,
      proposal: {
        ...ok.proposal,
        expenseId: 'wrong-share',
        payerAmount: ok.proposal.payerAmount + 1n,
        lines: [
          { ...(line as shared.Proposal['lines'][number]), amount: (line?.amount ?? 0n) - 1n },
        ],
      },
    });
    const otherNode = t.add('alice', 'EXPENSE_SUBMITTED', {
      ...ok,
      proposal: { ...ok.proposal, expenseId: 'other-node' },
      invoices: [
        {
          debtor: PK.bob,
          bolt11: t.invoice('alice', line?.amount ?? 0n, { node: `02${'ee'.repeat(32)}` }),
        },
      ],
    });
    const short = t.add('alice', 'EXPENSE_SUBMITTED', {
      ...ok,
      proposal: { ...ok.proposal, expenseId: 'short' },
      invoices: [
        {
          debtor: PK.bob,
          bolt11: t.invoice('alice', line?.amount ?? 0n, { expiresAt: T0 + 3_600 }),
        },
      ],
    });
    const trip = derive(t);
    expect(reasonOf(trip, wrongShare)).toMatch(/recomputed/);
    expect(reasonOf(trip, otherNode)).toMatch(/another node/);
    expect(reasonOf(trip, short)).toMatch(/lasts less than/);
  });
});

describe('D6 + C8: a block forbids expenses between the two, in both directions', () => {
  function blocked() {
    const t = TestTrip.withMembers();
    const before = t.expense('alice', ['bob']);
    const block = t.add('bob', 'MEMBER_BLOCKED', { target: PK.alice });
    return { t, before, block };
  }

  it('alice paying with bob as debtor, or bob paying with alice: invalid once the block is known', () => {
    const { t } = blocked();
    const aliceCharges = t.expense('alice', ['bob', 'charlie']);
    const bobCharges = t.expense('bob', ['alice']);
    const trip = derive(t);
    expect(reasonOf(trip, aliceCharges)).toMatch(/bob blocked alice/);
    expect(reasonOf(trip, bobCharges)).toMatch(/bob blocked alice/);
    // Invalid as a whole: charlie's line does not exist either.
    expect(trip.lines.has(lineKey(aliceCharges.id, PK.charlie))).toBe(false);
  });

  it('a third payer with both as debtors stays valid', () => {
    const { t } = blocked();
    const charlie = t.expense('charlie', ['alice', 'bob']);
    expect(reasonOf(derive(t), charlie)).toBeUndefined();
  });

  it('an expense concurrent with the block is valid (C8: the block was not known)', () => {
    const t = TestTrip.withMembers();
    const base = t.heads();
    t.add('bob', 'MEMBER_BLOCKED', { target: PK.alice }, { parents: base });
    const concurrent = t.expense('alice', ['bob'], { parents: base });
    expect(reasonOf(derive(t), concurrent)).toBeUndefined();
  });

  it('debts from before the block stay, to be paid by hand', () => {
    const { t, before } = blocked();
    t.add('bob', 'LINE_DECIDED', { expenseRef: before.id, decision: 'approve', amount: 300n });
    const trip = derive(t);
    const line = lineOf(trip, before, 'bob');
    expect(line).toMatchObject({ state: 'manual_only', manualOnly: 'blocked' });
    const policy = trip.members.get(PK.bob)?.policy ?? { autoPayLimit: 0n, dailyCap: 0n };
    expect(decideRegistryAutoPay(policy, line, trip, LATER, null).reason).toMatch(/by hand/);
    t.pay('bob', before);
    expect(lineOf(derive(t), before, 'bob').state).toBe('paid');
  });

  it('the app refuses to build the expense and says why, with the same rule', () => {
    const { t } = blocked();
    const f = derive(t).fold;
    expect(expenseRefusal(f, PK.alice, [PK.bob])).toMatch(/bob blocked alice/);
    expect(expenseRefusal(f, PK.bob, [PK.alice])).toMatch(/bob blocked alice/);
    expect(expenseRefusal(f, PK.charlie, [PK.alice, PK.bob])).toBeNull();
  });
});

describe('C7: unblock', () => {
  it('only who blocked can unblock', () => {
    const t = TestTrip.withMembers();
    t.add('bob', 'MEMBER_BLOCKED', { target: PK.alice });
    const byCharlie = t.add('charlie', 'MEMBER_UNBLOCKED', { target: PK.alice });
    expect(reasonOf(derive(t), byCharlie)).toMatch(/only who blocked/);
  });

  it('removes every known block of the author on that member; a new block blocks again', () => {
    const t = TestTrip.withMembers();
    t.add('bob', 'MEMBER_BLOCKED', { target: PK.alice });
    t.add('bob', 'MEMBER_BLOCKED', { target: PK.alice });
    t.add('bob', 'MEMBER_UNBLOCKED', { target: PK.alice });
    expect(derive(t).members.get(PK.alice)?.blockedBy).toEqual([]);
    const allowed = t.expense('alice', ['bob']);
    expect(reasonOf(derive(t), allowed)).toBeUndefined();
    expect(derive(t).lines.has(lineKey(allowed.id, PK.bob))).toBe(true);
    t.add('bob', 'MEMBER_BLOCKED', { target: PK.alice });
    expect(derive(t).members.get(PK.alice)?.blockedBy).toEqual([PK.bob]);
  });

  it('block and unblock concurrent: the block wins', () => {
    const t = TestTrip.withMembers();
    const first = t.add('bob', 'MEMBER_BLOCKED', { target: PK.alice });
    t.add('bob', 'MEMBER_BLOCKED', { target: PK.alice }, { parents: [first] });
    t.add('bob', 'MEMBER_UNBLOCKED', { target: PK.alice }, { parents: [first] });
    expect(derive(t).members.get(PK.alice)?.blockedBy).toEqual([PK.bob]);
  });
});

describe('exclusion: blocked by more than half of the others [T]', () => {
  it('two of two others block alice: excluded; one of two: not', () => {
    const t = TestTrip.withMembers();
    t.add('bob', 'MEMBER_BLOCKED', { target: PK.alice });
    expect(derive(t).members.get(PK.alice)?.excluded).toBe(false);
    t.add('charlie', 'MEMBER_BLOCKED', { target: PK.alice });
    const trip = derive(t);
    expect(trip.members.get(PK.alice)?.excluded).toBe(true);
    const exp = t.expense('alice', ['charlie']);
    expect(reasonOf(derive(t), exp)).toMatch(/excluded/);
  });

  it('a debt towards an excluded creditor is paid by hand', () => {
    // charlie leaves while alice charges him (C9) and approves; then bob, the only other member
    // still in the trip, blocks alice: she is excluded, and charlie has no block with her.
    const t = TestTrip.withMembers();
    const base = t.heads();
    const left = t.add('charlie', 'MEMBER_LEFT', {}, { parents: base });
    const e = t.expense('alice', ['charlie'], { parents: base });
    t.add(
      'charlie',
      'LINE_DECIDED',
      { expenseRef: e.id, decision: 'approve', amount: 300n },
      { parents: [left, e] },
    );
    t.add('bob', 'MEMBER_BLOCKED', { target: PK.alice });
    const trip = derive(t);
    expect(trip.members.get(PK.alice)?.excluded).toBe(true);
    expect(lineOf(trip, e, 'charlie')).toMatchObject({
      state: 'manual_only',
      manualOnly: 'creditor_excluded',
    });
  });

  it('definitive: unblocking does not lift it; only a new invite brings the member back', () => {
    const t = TestTrip.withMembers();
    const owed = t.expense('bob', ['alice']);
    t.add('bob', 'MEMBER_BLOCKED', { target: PK.alice });
    t.add('charlie', 'MEMBER_BLOCKED', { target: PK.alice });
    t.add('bob', 'MEMBER_UNBLOCKED', { target: PK.alice });
    t.add('charlie', 'MEMBER_UNBLOCKED', { target: PK.alice });
    let trip = derive(t);
    expect(trip.members.get(PK.alice)).toMatchObject({ excluded: true, blockedBy: [] });
    // the debts of the excluded stay, paid by hand
    expect(lineOf(trip, owed, 'alice')).toMatchObject({ manualOnly: 'debtor_excluded' });
    const refused = t.expense('charlie', ['alice']);
    expect(reasonOf(derive(t), refused)).toMatch(/alice is excluded/);
    const again = t.join('alice', t.invite('bob'));
    trip = derive(t);
    expect(reasonOf(trip, again)).toBeUndefined();
    expect(trip.members.get(PK.alice)?.excluded).toBe(false);
    const ok = t.expense('charlie', ['alice']);
    expect(reasonOf(derive(t), ok)).toBeUndefined();
  });

  it('back only with a new invite, never by joining again without one', () => {
    const t = TestTrip.withMembers();
    t.add('bob', 'MEMBER_BLOCKED', { target: PK.alice });
    t.add('charlie', 'MEMBER_BLOCKED', { target: PK.alice });
    const rejoin = t.join('alice', null);
    expect(reasonOf(derive(t), rejoin)).toMatch(/new invite/);
  });

  it('concurrency: an expense that did not know the exclusion is valid, one that knew it is not', () => {
    const t = TestTrip.withMembers();
    t.add('bob', 'MEMBER_BLOCKED', { target: PK.alice });
    const before = t.heads();
    const tipping = t.add('charlie', 'MEMBER_BLOCKED', { target: PK.alice }, { parents: before });
    const concurrent = t.expense('alice', ['charlie'], { parents: before });
    let trip = derive(t);
    expect(trip.members.get(PK.alice)?.excluded).toBe(true);
    expect(reasonOf(trip, concurrent)).toBeUndefined();
    expect(lineOf(trip, concurrent, 'charlie').afterExclusion).toBe(true);
    const after = t.expense('alice', ['charlie'], { parents: [tipping, concurrent] });
    trip = derive(t);
    expect(reasonOf(trip, after)).toMatch(/excluded/);
  });

  it('no silent assent on a line that arrived after the exclusion', () => {
    const t = TestTrip.withMembers();
    t.add('bob', 'MEMBER_BLOCKED', { target: PK.alice });
    const before = t.heads();
    const tipping = t.add('charlie', 'MEMBER_BLOCKED', { target: PK.alice }, { parents: before });
    const e = t.expense('alice', ['charlie'], { parents: before });
    t.add(
      'charlie',
      'LINE_SEEN',
      { expenseRef: e.id },
      { parents: [tipping, e], createdAt: T0 + 100 },
    );
    const line = lineOf(derive(t, T0 + 10_000), e, 'charlie');
    // without the rule: due after silent assent, then manual_only for the block
    expect(line.state).toBe('awaiting_explicit');
    const policy = { autoPayLimit: 2000n, dailyCap: 6000n };
    expect(
      decideRegistryAutoPay(policy, line, derive(t, T0 + 10_000), T0 + 10_000, null).reason,
    ).toMatch(/after an exclusion/);
  });

  it('a block concurrent with an unblock: the past of the block decides, not the fixed order', () => {
    const t = TestTrip.withMembers();
    t.add('bob', 'MEMBER_BLOCKED', { target: PK.alice });
    const base = t.heads();
    t.add('bob', 'MEMBER_UNBLOCKED', { target: PK.alice }, { parents: base });
    t.add('charlie', 'MEMBER_BLOCKED', { target: PK.alice }, { parents: base });
    for (let seed = 1; seed <= 20; seed++) {
      const trip = deriveRegistry(shuffled(t.events, seed), t.deps, LATER);
      expect(trip?.members.get(PK.alice)?.excluded).toBe(true);
    }
  });

  it('the app warns that a block also counts for the exclusion', () => {
    const t = TestTrip.withMembers();
    t.add('bob', 'MEMBER_BLOCKED', { target: PK.alice });
    expect(blockWarning(derive(t).fold, PK.charlie, PK.alice)).toMatch(
      /counts towards excluding alice: with it, 2 of the 2 other active members/,
    );
  });

  it.todo('factions: two halves blocking each other exclude each other (plan §11 D10)');
});

describe('leaving', () => {
  it('not with known debts, contested lines included', () => {
    const t = TestTrip.withMembers();
    const e = t.expense('alice', ['bob']);
    const tooEarly = t.add('bob', 'MEMBER_LEFT', {});
    t.add('bob', 'LINE_DECIDED', {
      expenseRef: e.id,
      decision: 'contest',
      amount: 300n,
      reason: 'not me',
    });
    const contested = t.add('bob', 'MEMBER_LEFT', {});
    t.pay('bob', e);
    const ok = t.add('bob', 'MEMBER_LEFT', {});
    const trip = derive(t);
    expect(reasonOf(trip, tooEarly)).toMatch(/known debts/);
    expect(reasonOf(trip, contested)).toMatch(/known debts/);
    expect(reasonOf(trip, ok)).toBeUndefined();
    expect(trip.members.get(PK.bob)?.left).toBe(true);
  });

  it('C9: a debt concurrent with the leave stays, marked, with no silent assent', () => {
    const t = TestTrip.withMembers();
    const base = t.heads();
    const left = t.add('bob', 'MEMBER_LEFT', {}, { parents: base });
    const e = t.expense('alice', ['bob'], { parents: base });
    t.add('bob', 'LINE_SEEN', { expenseRef: e.id }, { parents: [left, e], createdAt: T0 + 100 });
    const trip = derive(t, T0 + 10_000);
    expect(reasonOf(trip, e)).toBeUndefined();
    expect(lineOf(trip, e, 'bob')).toMatchObject({
      afterLeaving: true,
      state: 'awaiting_explicit',
    });
    const policy = trip.members.get(PK.bob)?.policy ?? { autoPayLimit: 0n, dailyCap: 0n };
    expect(
      decideRegistryAutoPay(policy, lineOf(trip, e, 'bob'), trip, T0 + 10_000, null).reason,
    ).toMatch(/after you left/);
  });

  it('C9: whoever left can still contest or approve those lines', () => {
    const t = TestTrip.withMembers();
    const base = t.heads();
    const left = t.add('bob', 'MEMBER_LEFT', {}, { parents: base });
    const e = t.expense('alice', ['bob'], { parents: base });
    const contest = t.add(
      'bob',
      'LINE_DECIDED',
      {
        expenseRef: e.id,
        decision: 'contest',
        amount: 300n,
        reason: 'I had already left',
      },
      { parents: [left, e] },
    );
    let trip = derive(t);
    expect(reasonOf(trip, contest)).toBeUndefined();
    expect(lineOf(trip, e, 'bob').state).toBe('contested');
    t.add('bob', 'LINE_DECIDED', { expenseRef: e.id, decision: 'approve', amount: 300n });
    trip = derive(t);
    expect(lineOf(trip, e, 'bob').state).toBe('due');
  });

  it('an expense charging a member whose leave it knows is invalid', () => {
    const t = TestTrip.withMembers();
    t.add('bob', 'MEMBER_LEFT', {});
    const e = t.expense('alice', ['bob']);
    expect(reasonOf(derive(t), e)).toMatch(/has left/);
  });
});

describe('CHECKPOINT: only an active member', () => {
  const body = { frontier: ['0'.repeat(64)], count: 1, stateHash: '0'.repeat(64) };

  it('active: valid; left or excluded: invalid', () => {
    const t = TestTrip.withMembers();
    const ok = t.add('alice', 'CHECKPOINT', body);
    t.add('charlie', 'MEMBER_LEFT', {});
    const left = t.add('charlie', 'CHECKPOINT', body);
    // bob is the only other member still in the trip: his block excludes alice.
    t.add('bob', 'MEMBER_BLOCKED', { target: PK.alice });
    const excluded = t.add('alice', 'CHECKPOINT', body);
    const trip = derive(t);
    expect(reasonOf(trip, ok)).toBeUndefined();
    expect(reasonOf(trip, left)).toMatch(/active member/);
    expect(reasonOf(trip, excluded)).toMatch(/active member/);
  });
});

describe('D4: table shares are an explicit consent, outside the daily cap', () => {
  it('paid with the daily cap used up, and not counted in it', () => {
    const t = TestTrip.withMembers();
    const e = t.expense('alice', ['bob'], { signed: ['bob'], unit: 5000n });
    let trip = derive(t);
    const line = lineOf(trip, e, 'bob');
    const inv = t.deps.decodeInvoice(line.invoice ?? '');
    const none = { autoPayLimit: 0n, dailyCap: 0n };
    expect(decideRegistryAutoPay(none, line, trip, LATER, inv)).toMatchObject({ pay: true });
    t.pay('bob', e);
    trip = derive(t);
    expect(trip.autoPayments.get(PK.bob) ?? []).toEqual([]);
  });
});

describe('shares in the precision of the trip asset', () => {
  it('6 decimals: the dinner in VND gives 9.677419 USD', () => {
    const receipt = {
      merchant: 'Pho 24',
      date: '2026-10-20',
      currency: 'VND' as const,
      items: [{ label: 'Pho', quantity: 2, unitPrice: 65_000n, total: 130_000n }],
      tip: 125_000n,
      total: 255_000n,
      warnings: [],
    };
    const shares = (assetDecimals: number) =>
      expenseShares({
        receipt,
        rate: '26350',
        assetDecimals,
        payer: PK.alice,
        payerItemIndexes: [0],
        debtors: [{ id: PK.bob, itemIndexes: [0] }],
      });
    expect(shares(2).totalUsdCents).toBe(968n);
    const six = shares(6);
    expect(six.totalUsdCents).toBe(9_677_419n);
    expect(six.payerCents + (six.debtors[0]?.cents ?? 0n)).toBe(9_677_419n);
  });

  it('a 6-decimal trip validates shares in micro-dollars, not in cents', () => {
    const t = TestTrip.withMembers(['bob', 'charlie'], { ...PARAMS, assetDecimals: 6 });
    const ok = t.expense('alice', ['bob', 'charlie'], { total: 1000n });
    const wrong = t.expense('alice', ['bob', 'charlie'], { total: 1000n, sharesDecimals: 2 });
    const trip = derive(t);
    expect(reasonOf(trip, ok)).toBeUndefined();
    // items split in the receipt currency (334 + 333 + 333 cents), then allocated in micro-dollars
    expect(lineOf(trip, ok, 'bob').amount).toBe(3_330_000n);
    expect(reasonOf(trip, wrong)).toMatch(/total is not the converted receipt total/);
  });
});

describe('D2: the invoice is checked before any payment', () => {
  it('payable only if issued for the line, to the creditor node, for the amount, not expired', () => {
    const t = TestTrip.withMembers();
    const e = t.expense('alice', ['bob'], { signed: ['bob'] });
    const trip = derive(t);
    const line = lineOf(trip, e, 'bob');
    const inv = t.deps.decodeInvoice(line.invoice ?? '');
    expect(invoiceRefusal(trip, line, inv, LATER)).toBeNull();
    expect(
      invoiceRefusal(trip, line, { ...inv, payeePubkey: `02${'ee'.repeat(32)}` }, LATER),
    ).toMatch(/node/);
    expect(invoiceRefusal(trip, line, { ...inv, cents: 1n }, LATER)).toMatch(/not for/);
    const other = t.deps.decodeInvoice(t.invoice('alice', line.amount));
    expect(invoiceRefusal(trip, line, other, LATER)).toMatch(/not one issued/);
    expect(invoiceRefusal(trip, line, inv, T0 + 30 * 86_400)).toMatch(/expired/);
    const policy = trip.members.get(PK.bob)?.policy ?? { autoPayLimit: 0n, dailyCap: 0n };
    expect(decideRegistryAutoPay(policy, line, trip, LATER, inv)).toMatchObject({ pay: true });
    expect(decideRegistryAutoPay(policy, line, trip, LATER, { ...inv, cents: 1n }).pay).toBe(false);
  });

  it('C5: a payment of the reissued invoice settles the line', () => {
    const t = TestTrip.withMembers();
    const e = t.expense('alice', ['bob'], { signed: ['bob'] });
    const bolt11 = t.invoice('alice', 300n);
    t.add('alice', 'INVOICE_REISSUED', { expenseRef: e.id, debtor: PK.bob, bolt11 });
    t.pay('bob', e, { bolt11 });
    const trip = derive(t);
    expect(trip.rejected).toEqual([]);
    expect(lineOf(trip, e, 'bob').state).toBe('paid');
  });
});

describe('contested lines decided by majority [23/10, provisional]', () => {
  /** alice pays, bob owes and contests. */
  function contested(others: Name[] = ['bob', 'charlie']) {
    const t = TestTrip.withMembers(others);
    const e = t.expense('alice', ['bob']);
    const contest = t.decide('bob', e, 'contest');
    return { t, e, contest };
  }

  it('three members: the one voter decides, "due" or "voided"', () => {
    for (const outcome of ['due', 'voided'] as const) {
      const { t, e } = contested();
      const vote = t.vote('charlie', e, 'bob', outcome);
      const trip = derive(t);
      expect(reasonOf(trip, vote)).toBeUndefined();
      expect(lineOf(trip, e, 'bob')).toMatchObject({
        state: outcome,
        group: { voters: [PK.charlie], outcome },
      });
    }
  });

  it('five members: three voters, two decide; until then the line stays contested', () => {
    const { t, e } = contested(['bob', 'charlie', 'm4', 'm5']);
    t.vote('charlie', e, 'bob', 'due');
    let line = lineOf(derive(t), e, 'bob');
    expect(line.state).toBe('contested');
    expect(line.group).toMatchObject({ due: [PK.charlie], outcome: null });
    expect(line.group?.voters).toHaveLength(3);
    t.vote('m4', e, 'bob', 'voided');
    expect(lineOf(derive(t), e, 'bob').state).toBe('contested');
    t.vote('m5', e, 'bob', 'due');
    line = lineOf(derive(t), e, 'bob');
    expect(line).toMatchObject({ state: 'due', group: { outcome: 'due' } });
  });

  it('creditor and debtor do not vote; nobody votes on a line that is not contested', () => {
    const { t, e } = contested();
    const byCreditor = t.vote('alice', e, 'bob', 'due');
    const byDebtor = t.vote('bob', e, 'bob', 'voided');
    const t2 = TestTrip.withMembers();
    const e2 = t2.expense('alice', ['bob']);
    const notContested = t2.vote('charlie', e2, 'bob', 'voided');
    expect(reasonOf(derive(t), byCreditor)).toMatch(/creditor and the debtor/);
    expect(reasonOf(derive(t), byDebtor)).toMatch(/creditor and the debtor/);
    expect(reasonOf(derive(t2), notContested)).toMatch(/not contested/);
  });

  it('counted on what the deciding vote knew: a concurrent vote does not count', () => {
    const { t, e, contest } = contested(['bob', 'charlie', 'm4', 'm5']);
    const a = t.vote('charlie', e, 'bob', 'voided', { parents: [contest] });
    const b = t.vote('m4', e, 'bob', 'voided', { parents: [contest] });
    // Two votes for "voided", but neither knows the other: no majority yet.
    let line = lineOf(derive(t), e, 'bob');
    expect(line.group).toMatchObject({ outcome: null });
    expect(line.state).toBe('contested');
    // m5 knows both and votes "due": its vote counts all three, 2 of 3 for "voided" decide.
    t.vote('m5', e, 'bob', 'due', { parents: [a, b] });
    line = lineOf(derive(t), e, 'bob');
    expect(line).toMatchObject({ state: 'voided', group: { outcome: 'voided' } });
  });

  it('definitive: later votes and a new contest do not change it', () => {
    const { t, e } = contested();
    t.vote('charlie', e, 'bob', 'due');
    const again = t.vote('charlie', e, 'bob', 'voided');
    const recontest = t.decide('bob', e, 'contest');
    const trip = derive(t);
    expect(reasonOf(trip, again)).toMatch(/already decided/);
    expect(reasonOf(trip, recontest)).toMatch(/cannot be contested again/);
    expect(lineOf(trip, e, 'bob').state).toBe('due');
  });

  it('"due" by the group is not paid automatically; approving it is', () => {
    const { t, e } = contested();
    t.vote('charlie', e, 'bob', 'due');
    const policy = { autoPayLimit: 2000n, dailyCap: 6000n };
    let trip = derive(t);
    expect(decideRegistryAutoPay(policy, lineOf(trip, e, 'bob'), trip, LATER, null)).toEqual({
      pay: false,
      reason: expect.stringMatching(/group decided you owe 300 to alice: approve it/),
    });
    t.decide('bob', e, 'approve');
    trip = derive(t);
    expect(lineOf(trip, e, 'bob')).toMatchObject({ state: 'due', approvedExplicitly: true });
  });

  it('C3: the debtor withdraws the contest before the majority; votes after it are refused', () => {
    const { t, e } = contested();
    t.decide('bob', e, 'approve');
    const late = t.vote('charlie', e, 'bob', 'voided');
    const trip = derive(t);
    expect(reasonOf(trip, late)).toMatch(/not contested/);
    expect(lineOf(trip, e, 'bob').state).toBe('due');
  });

  it('an approval concurrent with "voided" wins: the debtor accepted to pay', () => {
    const { t, e, contest } = contested();
    t.vote('charlie', e, 'bob', 'voided', { parents: [contest] });
    t.decide('bob', e, 'approve', { parents: [contest] });
    let trip = derive(t);
    expect(lineOf(trip, e, 'bob')).toMatchObject({
      state: 'due',
      approvedExplicitly: true,
      group: { outcome: 'voided' },
    });
    // An approval that knows the "voided" outcome is refused: nothing left to decide.
    const t2 = contested();
    t2.t.vote('charlie', t2.e, 'bob', 'voided');
    const after = t2.t.decide('bob', t2.e, 'approve');
    trip = derive(t2.t);
    expect(reasonOf(trip, after)).toMatch(/group voided this line/);
    expect(lineOf(trip, t2.e, 'bob').state).toBe('voided');
  });

  it('the payer can still void the expense, and a payment by hand still settles it', () => {
    const a = contested(['bob', 'charlie', 'm4', 'm5']);
    a.t.add('alice', 'EXPENSE_VOIDED', { expenseRef: a.e.id });
    expect(lineOf(derive(a.t), a.e, 'bob').state).toBe('voided');
    const b = contested(['bob', 'charlie', 'm4', 'm5']);
    b.t.pay('bob', b.e);
    expect(lineOf(derive(b.t), b.e, 'bob').state).toBe('paid');
  });

  it('a line voided by the group is not a debt: the debtor can leave', () => {
    const { t, e } = contested();
    t.vote('charlie', e, 'bob', 'voided');
    const left = t.add('bob', 'MEMBER_LEFT', {});
    expect(reasonOf(derive(t), left)).toBeUndefined();
  });

  it('the arrival order changes nothing', () => {
    const { t, e, contest } = contested(['bob', 'charlie', 'm4', 'm5']);
    const a = t.vote('charlie', e, 'bob', 'voided', { parents: [contest] });
    t.vote('m4', e, 'bob', 'due', { parents: [contest] });
    t.decide('bob', e, 'approve', { parents: [a] });
    t.vote('m5', e, 'bob', 'voided');
    const snap = (trip: RegistryTrip) =>
      JSON.stringify([
        lineOf(trip, e, 'bob').state,
        lineOf(trip, e, 'bob').group,
        trip.rejected.length,
      ]);
    const expected = snap(derive(t));
    fc.assert(
      fc.property(fc.integer(), (seed) => {
        const trip = deriveRegistry(shuffled(t.events, seed), t.deps, LATER);
        expect(trip && snap(trip)).toBe(expected);
      }),
      { numRuns: 100 },
    );
  });
});

describe('open questions: placeholders', () => {
  it.todo('D3: Sybil on invites, decided together with the exclusion policy');
  it.todo('weekend rate: age of a saved rate in market hours or a 72 h threshold (plan §11 D11)');
});

describe('properties', () => {
  it('the arrival order changes nothing', () => {
    const t = TestTrip.withMembers();
    const base = t.heads();
    const e1 = t.expense('alice', ['bob', 'charlie'], { signed: ['charlie'] });
    t.add('bob', 'MEMBER_BLOCKED', { target: PK.alice }, { parents: base });
    t.add('bob', 'LINE_SEEN', { expenseRef: e1.id }, { createdAt: T0 + 50 });
    t.pay('charlie', e1);
    t.expense('charlie', ['alice', 'bob']);
    // Rejected (alice is not a debtor of her own expense): rejections are order-free too.
    t.add(
      'alice',
      'LINE_DECIDED',
      { expenseRef: e1.id, decision: 'approve', amount: 300n },
      { parents: [e1] },
    );
    const snapshot = (trip: RegistryTrip) =>
      JSON.stringify(
        {
          lines: [...trip.lines.values()].map((l) => [l.key, l.state, l.manualOnly]).sort(),
          rejected: [...trip.rejected].map((r) => r.id).sort(),
          members: [...trip.members.values()]
            .map((m) => [m.pubkey, m.excluded, m.blockedBy])
            .sort(),
          stateHash: trip.stateHash,
        },
        (_k, v) => (typeof v === 'bigint' ? v.toString() : v),
      );
    const expected = snapshot(derive(t));
    fc.assert(
      fc.property(fc.integer(), (seed) => {
        const trip = deriveRegistry(shuffled(t.events, seed), t.deps, LATER);
        expect(trip && snapshot(trip)).toBe(expected);
      }),
      { numRuns: 200 },
    );
  });
});
