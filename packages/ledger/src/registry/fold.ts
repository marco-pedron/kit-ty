import type { registry } from '@kitty/shared';
import { effectivePolicy, settleLine, voidedLines, type PolicyLimits } from '../conflicts.js';
import type { Causality } from '../order.js';

// The time-free state of a set of registry events (step 2, docs/ADR-001-formato-eventi.md).
// fold() applies the events of a causally closed set in the fixed order; validity of each
// event is decided before, on the fold of its own ancestors ("known" = among the ancestors,
// plan §3.2), so it never depends on what arrived later or in which order.
//
// Nothing here depends on the clock: silent assent and invoice expiry are in derive.ts.

type RegistryEvent = registry.RegistryEvent;
type Body<T extends registry.EventType> = registry.EventBody<T>;

export interface MemberRecord {
  pubkey: string;
  displayName: string;
  nodePubkey: string;
  joinId: string;
  /** The MEMBER_INVITED used; null for the trip creator. */
  inviteRef: string | null;
  invitedBy: string | null;
  /** MEMBER_JOINED's policy first, then every POLICY_UPDATED (C12). */
  policyUpdates: { id: string; policy: PolicyLimits }[];
  leftId: string | null;
}

export interface LineRecord {
  key: string;
  expenseRef: string;
  payer: string;
  debtor: string;
  amount: bigint;
  itemIndexes: readonly number[];
  /** The debtor signed the proposal at the table: due at once, an explicit approval. */
  signedAtTable: boolean;
  /** The original invoice, then every INVOICE_REISSUED (C5, C6). */
  invoices: { eventId: string; bolt11: string }[];
  seen: { id: string; createdAt: number } | null;
  decisions: { id: string; decision: 'approve' | 'contest'; reason: string | null }[];
  payments: {
    id: string;
    amount: bigint;
    createdAt: number;
    rail: 'ln' | 'onchain';
    paymentHash: string | null;
    preimage: string | null;
    txid: string | null;
  }[];
}

export interface ExpenseRecord {
  id: string;
  payer: string;
  createdAt: number;
  body: Body<'EXPENSE_SUBMITTED'>;
  voids: string[];
}

export interface InviteRecord {
  id: string;
  author: string;
  body: Body<'MEMBER_INVITED'>;
  usedBy: string | null;
}

export interface Fold {
  c: Causality;
  tripId: string;
  creator: string;
  created: Body<'TRIP_CREATED'>;
  members: Map<string, MemberRecord>;
  invites: Map<string, InviteRecord>;
  /** blocker → target → ids of its blocks still in force (C7). */
  blocks: Map<string, Map<string, Set<string>>>;
  expenses: Map<string, ExpenseRecord>;
  lines: Map<string, LineRecord>;
  checkpoints: string[];
}

export const lineKey = (expenseRef: string, debtor: string) => `${expenseRef}:${debtor}`;

/**
 * Applies `events` (a causally closed set, in the fixed order, each already valid on its own
 * ancestors) and returns the state. The genesis must be TRIP_CREATED. An event is skipped when
 * the set itself rules it out: a second MEMBER_JOINED with the same invite (C13, first in the
 * fixed order), or any event of an author who is not a member in this set.
 */
export function fold(c: Causality, events: readonly RegistryEvent[]): Fold | null {
  const [genesis, ...rest] = events;
  if (genesis?.content.type !== 'TRIP_CREATED') return null;
  const f: Fold = {
    c,
    tripId: genesis.content.tripId,
    creator: genesis.author,
    created: genesis.content.body,
    members: new Map(),
    invites: new Map(),
    blocks: new Map(),
    expenses: new Map(),
    lines: new Map(),
    checkpoints: [],
  };
  for (const e of rest) apply(f, e);
  return f;
}

function apply(f: Fold, e: RegistryEvent): void {
  const { content } = e;
  if (content.type === 'MEMBER_JOINED') {
    join(f, e.id, e.author, content.body);
    return;
  }
  if (!f.members.has(e.author)) return;
  switch (content.type) {
    case 'TRIP_CREATED':
    case 'TRIP_SECRET_SHARED':
      return;
    case 'MEMBER_INVITED':
      f.invites.set(e.id, { id: e.id, author: e.author, body: content.body, usedBy: null });
      return;
    case 'POLICY_UPDATED':
      f.members.get(e.author)?.policyUpdates.push({ id: e.id, policy: content.body.policy });
      return;
    case 'MEMBER_BLOCKED': {
      const byAuthor = f.blocks.get(e.author) ?? new Map<string, Set<string>>();
      byAuthor.set(content.body.target, (byAuthor.get(content.body.target) ?? new Set()).add(e.id));
      f.blocks.set(e.author, byAuthor);
      return;
    }
    case 'MEMBER_UNBLOCKED': {
      // C7: removes every block of the author on the target that the unblock knows; a
      // concurrent block stays.
      const ids = f.blocks.get(e.author)?.get(content.body.target);
      if (ids) for (const b of [...ids]) if (f.c.precedes(b, e.id)) ids.delete(b);
      return;
    }
    case 'MEMBER_LEFT': {
      const m = f.members.get(e.author);
      if (m && m.leftId === null) m.leftId = e.id;
      return;
    }
    case 'EXPENSE_SUBMITTED': {
      const b = content.body;
      f.expenses.set(e.id, {
        id: e.id,
        payer: e.author,
        createdAt: e.createdAt,
        body: b,
        voids: [],
      });
      const signers = new Set(b.tableSignatures.map((s) => s.signer));
      for (const l of b.proposal.lines) {
        const bolt11 = b.invoices.find((i) => i.debtor === l.debtor)?.bolt11 ?? '';
        f.lines.set(lineKey(e.id, l.debtor), {
          key: lineKey(e.id, l.debtor),
          expenseRef: e.id,
          payer: e.author,
          debtor: l.debtor,
          amount: l.amount,
          itemIndexes: l.itemIndexes,
          signedAtTable: signers.has(l.debtor),
          invoices: [{ eventId: e.id, bolt11 }],
          seen: null,
          decisions: [],
          payments: [],
        });
      }
      return;
    }
    case 'LINE_SEEN': {
      const line = f.lines.get(lineKey(content.body.expenseRef, e.author));
      if (line && line.seen === null) line.seen = { id: e.id, createdAt: e.createdAt };
      return;
    }
    case 'LINE_DECIDED': {
      const b = content.body;
      f.lines.get(lineKey(b.expenseRef, e.author))?.decisions.push({
        id: e.id,
        decision: b.decision,
        reason: b.reason ?? null,
      });
      return;
    }
    case 'PAYMENT_MADE': {
      const b = content.body;
      f.lines.get(lineKey(b.expenseRef, e.author))?.payments.push({
        id: e.id,
        amount: b.amount,
        createdAt: e.createdAt,
        rail: b.rail,
        paymentHash: b.rail === 'ln' ? b.paymentHash : null,
        preimage: b.rail === 'ln' ? b.preimage : null,
        txid: b.rail === 'onchain' ? b.txid : null,
      });
      return;
    }
    case 'EXPENSE_VOIDED':
      f.expenses.get(content.body.expenseRef)?.voids.push(e.id);
      return;
    case 'INVOICE_REISSUED': {
      const b = content.body;
      f.lines
        .get(lineKey(b.expenseRef, b.debtor))
        ?.invoices.push({ eventId: e.id, bolt11: b.bolt11 });
      return;
    }
    case 'CHECKPOINT':
      f.checkpoints.push(e.id);
      return;
  }
}

function join(f: Fold, id: string, author: string, b: Body<'MEMBER_JOINED'>): void {
  if (f.members.has(author)) return;
  if ([...f.members.values()].some((m) => m.nodePubkey === b.nodePubkey)) return;
  let invitedBy: string | null = null;
  if (b.inviteRef !== null) {
    const invite = f.invites.get(b.inviteRef);
    // C13: one invite, one join; the first in the fixed order.
    if (invite === undefined || invite.usedBy !== null) return;
    invite.usedBy = author;
    invitedBy = invite.author;
  } else if (author !== f.creator) return;
  f.members.set(author, {
    pubkey: author,
    displayName: b.displayName,
    nodePubkey: b.nodePubkey,
    joinId: id,
    inviteRef: b.inviteRef,
    invitedBy,
    policyUpdates: [{ id, policy: b.policy }],
    leftId: null,
  });
}

// ---------- member states (plan §3.1) ----------

/** Who keeps a block in force on `target`. */
export function blockersOf(f: Fold, target: string): string[] {
  const out: string[] = [];
  for (const [blocker, targets] of f.blocks)
    if ((targets.get(target)?.size ?? 0) > 0 && f.members.has(blocker)) out.push(blocker);
  return out.sort();
}

/** `a` keeps a block in force on `b`. */
export function blocks(f: Fold, a: string, b: string): boolean {
  return (f.blocks.get(a)?.get(b)?.size ?? 0) > 0;
}

/**
 * D6, the only place of the rule: a block between a and b, in either direction, forbids every
 * expense where one of them pays and the other owes. Null when allowed, otherwise the reason
 * shown to whoever tries to register it. Used by validateRegistryEvent and by the app before
 * it lets anyone build such an expense (expenseRefusal).
 */
export function pairBlockRefusal(f: Fold, payer: string, debtor: string): string | null {
  const name = (pk: string) => f.members.get(pk)?.displayName ?? `${pk.slice(0, 8)}…`;
  if (blocks(f, payer, debtor))
    return `${name(payer)} blocked ${name(debtor)}: no expense can have one of them paying and the other owing.`;
  if (blocks(f, debtor, payer))
    return `${name(debtor)} blocked ${name(payer)}: no expense can have one of them paying and the other owing.`;
  return null;
}

/** Joined and not left. */
export function inTrip(f: Fold, pk: string): boolean {
  const m = f.members.get(pk);
  return m !== undefined && m.leftId === null;
}

/**
 * Excluded: blocked by more than half of the other members still in the trip [T]. Blocks of
 * every member in the trip count, excluded or not, so exclusion is not circular (plan §3.1).
 * Computed, never an event; it lapses when blocks drop below the threshold [T].
 * TODO(factions): two halves blocking each other exclude each other; deterministic, to be
 * shown in the UI, open question (plan §11 D10).
 */
export function isExcluded(f: Fold, pk: string): boolean {
  if (!inTrip(f, pk)) return false;
  const others = [...f.members.keys()].filter((x) => x !== pk && inTrip(f, x));
  const against = others.filter((a) => blocks(f, a, pk)).length;
  return 2 * against > others.length;
}

/** In the trip and not excluded: may submit expenses, invite, block, leave, checkpoint. */
export function isActive(f: Fold, pk: string): boolean {
  return inTrip(f, pk) && !isExcluded(f, pk);
}

export function memberPolicy(f: Fold, pk: string): PolicyLimits | null {
  const m = f.members.get(pk);
  return m ? effectivePolicy(f.c, m.policyUpdates) : null;
}

// ---------- line settlement (C2, C4, C11) ----------

export function linesOf(f: Fold, expenseRef: string): LineRecord[] {
  return [...f.lines.values()].filter((l) => l.expenseRef === expenseRef);
}

/** The payment that settles the line, and the overpayments that become credits (C4). */
export function settlement(f: Fold, line: LineRecord) {
  return settleLine(f.c, line.payments);
}

/** The lines of the expense voided by its payer (C2: a paid line stays). */
export function voidedOf(f: Fold, expense: ExpenseRecord): Set<string> {
  const lines = linesOf(f, expense.id);
  const paid = new Set(lines.filter((l) => l.payments.length > 0).map((l) => l.debtor));
  return voidedLines(
    expense.voids.map((id) => ({ id })),
    lines.map((l) => l.debtor),
    paid,
  );
}

/** Not paid and not voided: a debt of the debtor (contested lines count, plan §3.4). */
export function isOpen(f: Fold, line: LineRecord): boolean {
  const expense = f.expenses.get(line.expenseRef);
  if (line.payments.length > 0) return false;
  return expense === undefined || !voidedOf(f, expense).has(line.debtor);
}

export function openDebtsOf(f: Fold, pk: string): LineRecord[] {
  return [...f.lines.values()].filter((l) => l.debtor === pk && isOpen(f, l));
}
