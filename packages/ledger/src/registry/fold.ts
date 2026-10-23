import type { registry } from '@kitty/shared';
import {
  effectivePolicy,
  lineDecision,
  settleLine,
  voidedLines,
  type PolicyLimits,
} from '../conflicts.js';
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
  /** The MEMBER_BLOCKED events that excluded this member (definitive, see isExcluded). */
  exclusions: string[];
  /** MEMBER_JOINED with a new invite after an exclusion: back in the trip. */
  readmissions: string[];
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
  /** LINE_VOTED on this line, in the fixed order (23/10, provisional). */
  votes: { id: string; voter: string; outcome: VoteOutcome }[];
  /** The vote that brought one outcome over the majority: definitive (groupOutcome). */
  groupOutcome: { id: string; outcome: VoteOutcome } | null;
}

export type VoteOutcome = 'due' | 'voided';

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
  /** Every block and unblock, for the blocks in force in the past of an event (exclusion). */
  blockLog: { id: string; author: string; target: string; unblock: boolean }[];
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
    blockLog: [],
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
      f.blockLog.push({ id: e.id, author: e.author, target: content.body.target, unblock: false });
      const target = f.members.get(content.body.target);
      if (target && excludedAt(f, target.pubkey, e.id)) target.exclusions.push(e.id);
      return;
    }
    case 'MEMBER_UNBLOCKED': {
      // C7: removes every block of the author on the target that the unblock knows; a
      // concurrent block stays.
      const ids = f.blocks.get(e.author)?.get(content.body.target);
      if (ids) for (const b of [...ids]) if (f.c.precedes(b, e.id)) ids.delete(b);
      f.blockLog.push({ id: e.id, author: e.author, target: content.body.target, unblock: true });
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
          votes: [],
          groupOutcome: null,
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
    case 'LINE_VOTED': {
      const b = content.body;
      const line = f.lines.get(lineKey(b.expenseRef, b.debtor));
      if (line === undefined) return;
      line.votes.push({ id: e.id, voter: e.author, outcome: b.outcome });
      if (line.groupOutcome === null) {
        const decided = groupMajority(f, line, e.id).decided;
        if (decided !== null) line.groupOutcome = { id: e.id, outcome: decided };
      }
      return;
    }
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
  const existing = f.members.get(author);
  if (existing !== undefined) {
    // Back after an exclusion, with a new invite (validated on what the joiner knew).
    const invite = b.inviteRef === null ? undefined : f.invites.get(b.inviteRef);
    if (existing.exclusions.length === 0 || invite === undefined || invite.usedBy !== null) return;
    invite.usedBy = author;
    existing.readmissions.push(id);
    return;
  }
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
    exclusions: [],
    readmissions: [],
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

const atOrBefore = (f: Fold, x: string, y: string) => x === y || f.c.precedes(x, y);

/** An exclusion of `m` known at `at` and not followed by a readmission known at `at`. */
function excludedIn(f: Fold, m: MemberRecord, at: string | null): boolean {
  const known = (x: string) => at === null || atOrBefore(f, x, at);
  return m.exclusions.some(
    (x) => known(x) && !m.readmissions.some((r) => known(r) && f.c.precedes(x, r)),
  );
}

/** In the trip and not excluded in the past of `at` (the whole fold when null). */
function activeAt(f: Fold, pk: string, at: string | null): boolean {
  const m = f.members.get(pk);
  if (m === undefined) return false;
  if (at !== null && !atOrBefore(f, m.joinId, at)) return false;
  if (m.leftId !== null && (at === null || atOrBefore(f, m.leftId, at))) return false;
  return !excludedIn(f, m, at);
}

/** `blocker` keeps a block on `target` in force in the past of `at` (C7: an unblock removes the blocks it knows). */
function blockInForceAt(f: Fold, blocker: string, target: string, at: string): boolean {
  const mine = f.blockLog.filter(
    (x) => x.author === blocker && x.target === target && atOrBefore(f, x.id, at),
  );
  return mine.some((b) => !b.unblock && !mine.some((u) => u.unblock && f.c.precedes(b.id, u.id)));
}

/**
 * The majority rule [T], on the past of `at` only, so concurrent events and the fixed order
 * never change it: the other active members, and how many of them keep a block on `pk`.
 */
export function blockersMajority(
  f: Fold,
  pk: string,
  at: string | null,
): { against: number; others: number } {
  const others = [...f.members.keys()].filter((x) => x !== pk && activeAt(f, x, at));
  const against = others.filter((a) =>
    at === null ? blocks(f, a, pk) : blockInForceAt(f, a, pk, at),
  ).length;
  return { against, others: others.length };
}

/** On applying a block at `at`: does it bring `pk` over the majority? */
function excludedAt(f: Fold, pk: string, at: string): boolean {
  if (!activeAt(f, pk, at)) return false;
  const { against, others } = blockersMajority(f, pk, at);
  return 2 * against > others;
}

/**
 * Excluded: a block brought the members blocking `pk` to more than half of the other active
 * members, in the past of that block [T, 22/10]. Definitive: later unblocks do not lift it;
 * only a MEMBER_JOINED with a new invite that knows the exclusion brings the member back.
 * Blocks of excluded members do not count. An event that does not know the exclusion
 * (concurrent with the block) does not see it, as for C8.
 * Limit: depends on D3 (Sybil): with fake members one person can reach the majority.
 * TODO(factions): two halves blocking each other exclude each other; deterministic, to be
 * shown in the UI, open question (plan §11 D10).
 */
export function isExcluded(f: Fold, pk: string): boolean {
  const m = f.members.get(pk);
  return m !== undefined && m.leftId === null && excludedIn(f, m, null);
}

/** The exclusions of `pk` concurrent with `id`: what `id` did not know. */
export function exclusionsConcurrentWith(f: Fold, pk: string, id: string): string[] {
  return (f.members.get(pk)?.exclusions ?? []).filter((x) => f.c.concurrent(x, id));
}

/**
 * What the app tells whoever is about to block `target`: the block counts for the exclusion.
 */
export function blockWarning(f: Fold, blocker: string, target: string): string {
  const name = f.members.get(target)?.displayName ?? `${target.slice(0, 8)}…`;
  const { against, others } = blockersMajority(f, target, null);
  const after = against + (blocks(f, blocker, target) ? 0 : 1);
  return (
    `Your block also counts towards excluding ${name}: with it, ${after} of the ${others} other ` +
    `active members block ${name}. Over half excludes ${name} from the trip for good; ` +
    `unblocking later does not undo it, only a new invite does.`
  );
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
  if (line.payments.length > 0 || voidedByGroup(f, line)) return false;
  return expense === undefined || !voidedOf(f, expense).has(line.debtor);
}

// ---------- contested lines decided by majority (23/10, provisional) ----------
//
// The only place of the rule: the final model of disputes without an arbiter is still open
// (D5). Who votes, on what, and when an outcome is reached is decided here; derive.ts and
// validate.ts only read groupMajority, groupOutcome and voidedByGroup.

/**
 * The votes on a contested line in the past of `at` (the whole fold when null), counted as for
 * the exclusion: the voters are the active members other than its creditor and debtor; a vote
 * counts if it knew every decision of the debtor that `at` knows, i.e. it was cast on the
 * contest in force there; one vote per voter (the first in the fixed order). An outcome is
 * decided when more than half of the voters chose it.
 * Limits: depends on D3 (Sybil); in a group of three there is one voter, who decides alone.
 */
export function groupMajority(
  f: Fold,
  line: LineRecord,
  at: string | null,
): { voters: string[]; due: string[]; voided: string[]; decided: VoteOutcome | null } {
  const known = (x: string) => at === null || atOrBefore(f, x, at);
  const voters = [...f.members.keys()]
    .filter((m) => m !== line.payer && m !== line.debtor && activeAt(f, m, at))
    .sort();
  const decisions = line.decisions.filter((d) => known(d.id));
  const counted = new Map<string, VoteOutcome>();
  for (const v of line.votes) {
    if (!known(v.id) || !voters.includes(v.voter) || counted.has(v.voter)) continue;
    if (decisions.every((d) => atOrBefore(f, d.id, v.id))) counted.set(v.voter, v.outcome);
  }
  const by = (o: VoteOutcome) => [...counted].filter(([, x]) => x === o).map(([m]) => m);
  const due = by('due');
  const voided = by('voided');
  const decided =
    2 * due.length > voters.length ? 'due' : 2 * voided.length > voters.length ? 'voided' : null;
  return { voters, due, voided, decided };
}

/**
 * Voided by the group: the outcome is "voided", unless the debtor approved concurrently with
 * the deciding vote. The debtor accepted to pay [23/10]: the approval wins.
 */
export function voidedByGroup(f: Fold, line: LineRecord): boolean {
  const o = line.groupOutcome;
  if (o === null || o.outcome !== 'voided') return false;
  return !line.decisions.some((d) => d.decision === 'approve' && f.c.concurrent(d.id, o.id));
}

/** Why `voter` cannot vote on `line` now (validation and the app), or null. */
export function voteRefusal(f: Fold, line: LineRecord, voter: string): string | null {
  if (!isActive(f, voter)) return 'only an active member can vote';
  if (voter === line.payer || voter === line.debtor)
    return 'the creditor and the debtor of a line do not vote on it';
  if (!isOpen(f, line)) return 'the line is already settled';
  if (line.groupOutcome !== null) return 'the group already decided this line';
  if (lineDecision(f.c, line.decisions) !== 'contest') return 'the line is not contested';
  const { due, voided } = groupMajority(f, line, null);
  if (due.includes(voter) || voided.includes(voter)) return 'you already voted on this contest';
  return null;
}

export function openDebtsOf(f: Fold, pk: string): LineRecord[] {
  return [...f.lines.values()].filter((l) => l.debtor === pk && isOpen(f, l));
}
