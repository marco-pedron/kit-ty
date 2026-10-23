// OWNED BY STREAM C (task C3): GET /api/:as/state. The TripView is built from the agent's own
// verified copy of the log (MemberAgent, task A5), never from the relay, and from the member's
// own node for balances. Privacy (SPEC §1): a traveler gets only their own balances and lines
// in full; dave gets the operator screens and no traveler balance.
import {
  DEFAULT_POLICY,
  FINAL_LINE_STATES,
  formatCents,
  isMemberId,
  roleOf,
  type ActivityItem,
  type ActorId,
  type AiStatus,
  type BalanceView,
  type CoordinatorView,
  type ExpenseItemView,
  type ExpenseView,
  type LedgerHealth,
  type LineView,
  type MemberId,
  type MemberView,
  type MeView,
  type ProofRef,
  type StoredEvent,
  type TripView,
} from '@kitty/shared';
import {
  autoPaidLast24h,
  lineKey,
  liquidityPlan,
  type ExpenseRecord,
  type LineRecord,
  type TripState,
} from '@kitty/ledger';
import { CoordinatorAgent } from '../flows/dave.js';
import type { MemberAgent } from '../flows/member-agent.js';
import type { WalletBalances } from '../wallet/types.js';

export interface StateInput {
  as: ActorId;
  /** null while this actor's agent is not running (no wallet yet: B3, or no runtime). */
  agent: MemberAgent | null;
  /** From the member's own node; null if unreachable or unknown. Ignored for dave. */
  balances: WalletBalances | null;
  ai: AiStatus['status'] | null;
  fakes: boolean;
  explorerBaseUrl: string;
  now: Date;
}

const EMPTY_HEALTH: LedgerHealth = {
  events: 0,
  validSignatures: 0,
  chainValid: true,
  headSeq: 0,
  headHash: null,
  checkpoints: null,
};

const iso = (d: Date | null) => (d === null ? null : d.toISOString());
const isFinal = (l: LineRecord) => FINAL_LINE_STATES.includes(l.state);

export function buildTripView(input: StateInput): TripView {
  const { as, agent, now } = input;
  const trip = agent?.trip() ?? null;
  const ctx = trip === null ? null : new ViewContext(trip, agent!, now);
  const meMember = agent?.me(trip) ?? null;

  const me: MeView | null = isMemberId(as)
    ? {
        memberId: as,
        policy: agent?.policy(trip) ?? DEFAULT_POLICY,
        balance: trip === null ? null : balanceView(trip, input.balances),
        oweCents: meMember?.oweCents ?? 0n,
        owedToMeCents: meMember?.owedToMeCents ?? 0n,
        autoPaidTodayCents:
          trip === null || meMember === null ? 0n : autoPaidLast24h(trip, meMember.pubkey, now),
        debts: ctx?.linesWhere((l) => l.debtorPubkey === meMember?.pubkey) ?? [],
        credits: ctx?.linesWhere((l) => l.payerPubkey === meMember?.pubkey) ?? [],
      }
    : null;

  return {
    as,
    role: roleOf(as),
    fakes: input.fakes,
    serverNow: now.toISOString(),
    trip:
      trip === null
        ? null
        : {
            tripId: trip.tripId,
            name: trip.name,
            assetId: trip.assetId,
            status: trip.closed ? 'closed' : 'open',
            params: trip.params,
          },
    rate: trip?.rate?.body ?? null,
    members: ctx?.members() ?? [],
    me,
    coordinator: as === 'dave' ? (ctx?.coordinator() ?? EMPTY_COORDINATOR) : null,
    expenses: ctx?.expenses() ?? [],
    activity: ctx?.activity() ?? [...(agent?.activity() ?? [])],
    operations: [...(agent?.operations() ?? [])],
    ai: { status: input.ai ?? 'loading', fake: input.fakes },
    ledger: agent?.log.health() ?? EMPTY_HEALTH,
    explorerBaseUrl: input.explorerBaseUrl,
  };
}

/** The ExpenseView of one expense (by id or event hash) after an action; null if unknown. */
export function expenseViewOf(
  agent: MemberAgent,
  ref: { expenseId?: string; eventHash?: string },
  now: Date,
): ExpenseView | null {
  const trip = agent.trip();
  if (trip === null) return null;
  const e = [...trip.expenses.values()].find(
    (x) => x.eventHash === ref.eventHash || x.body.expenseId === ref.expenseId,
  );
  return e === undefined ? null : new ViewContext(trip, agent, now).expense(e);
}

/** The LineView of one line after an action. */
export function lineViewOf(agent: MemberAgent, line: LineRecord, now: Date): LineView {
  const trip = agent.trip();
  if (trip === null) throw new Error('no trip yet');
  return new ViewContext(trip, agent, now).line(
    trip.lines.get(lineKey(line.expenseEventHash, line.debtorPubkey)) ?? line,
  );
}

const EMPTY_COORDINATOR: CoordinatorView = { members: [], disputes: [], defaults: [] };

function balanceView(trip: TripState, b: WalletBalances | null): BalanceView | null {
  if (b === null) return null;
  const d = trip.params.tripChannelCents;
  return {
    tripOutboundCents: b.tripOutboundCents,
    inboundCents: b.inboundCents,
    onchainCents: b.onchainCents,
    tripChannelCents: d,
    topupWarning: b.tripOutboundCents * 100n < d * BigInt(trip.params.topupWarnPercent),
  };
}

/** Lookups shared by every part of the view, for one trip at one instant. */
class ViewContext {
  private readonly names = new Map<string, MemberId>();

  constructor(
    readonly trip: TripState,
    readonly agent: MemberAgent,
    readonly now: Date,
  ) {
    for (const m of trip.members.values()) this.names.set(m.pubkey, m.memberId);
  }

  name(pubkey: string): MemberId {
    const n = this.names.get(pubkey);
    // validateEvent only accepts payers and debtors who are members (SPEC §9.3).
    if (n === undefined) throw new Error(`no member with key ${pubkey.slice(0, 8)}…`);
    return n;
  }

  members(): MemberView[] {
    const registry = this.agent.registry;
    const standing = registry?.standing() ?? null;
    return [...this.trip.members.values()].map((m) => ({
      memberId: m.memberId,
      displayName: m.displayName,
      pubkey: m.pubkey,
      nodePubkey: m.nodePubkey,
      status: m.excluded
        ? 'excluded'
        : m.channelsReady
          ? 'active'
          : m.admitted
            ? 'admitted'
            : 'joined',
      closingTxids: [...m.closingTxids],
      ...(registry !== null && { registry: standing?.get(m.nodePubkey) ?? null }),
    }));
  }

  /** Newest expense first, then in the order of the expense's lines. */
  private sortedLines(pick: (l: LineRecord) => boolean): LineRecord[] {
    const seqOf = (l: LineRecord) => this.trip.expenses.get(l.expenseEventHash)?.seq ?? 0;
    return [...this.trip.lines.values()].filter(pick).sort((a, b) => seqOf(b) - seqOf(a));
  }

  linesWhere(pick: (l: LineRecord) => boolean): LineView[] {
    return this.sortedLines(pick).map((l) => this.line(l));
  }

  line(l: LineRecord): LineView {
    const expense = this.trip.expenses.get(l.expenseEventHash);
    const invoice = this.agent.log.invoices.get(l.bolt11);
    // Every invoice is decoded by this member's node before its event is accepted
    // (LocalLog); the fallback only covers a reissued invoice not decoded yet.
    const expiresAt =
      invoice?.expiresAt ??
      new Date(
        (expense?.submittedAt.getTime() ?? this.now.getTime()) +
          this.trip.params.invoiceExpirySeconds * 1000,
      ).toISOString();
    return {
      expenseId: l.expenseId,
      expenseEventHash: l.expenseEventHash,
      payer: this.name(l.payerPubkey),
      debtor: this.name(l.debtorPubkey),
      cents: l.cents,
      itemIndexes: [...l.itemIndexes],
      state: l.state,
      seenAt: iso(l.seenAt),
      deadlineAt: iso(l.deadlineAt),
      contestReason: l.contestReason,
      resolution:
        l.resolution === null
          ? null
          : { outcome: l.resolution, note: this.resolutionNote(l) ?? '' },
      agent: this.agent.decisionFor(l, this.trip),
      paidBy: l.payment?.by ?? null,
      proof: proofRef(l),
      invoiceExpiresAt: expiresAt,
    };
  }

  /** LineRecord keeps the outcome only; the note is in the DISPUTE_RESOLVED event. */
  private resolutionNote(l: LineRecord): string | null {
    for (let i = this.agent.log.events.length - 1; i >= 0; i--) {
      const inner = this.agent.log.events[i]!.signed.inner;
      if (
        inner.type === 'DISPUTE_RESOLVED' &&
        inner.body.expenseEventHash === l.expenseEventHash &&
        inner.body.debtorPubkey === l.debtorPubkey
      )
        return inner.body.note;
    }
    return null;
  }

  items(e: ExpenseRecord, only?: readonly number[]): ExpenseItemView[] {
    const { receipt, payerItemIndexes, lines } = e.body;
    return receipt.items
      .map((it, index) => ({
        index,
        label: it.label,
        quantity: it.quantity,
        total: it.total,
        members: [
          ...(payerItemIndexes.includes(index) ? [this.name(e.payerPubkey)] : []),
          ...lines
            .filter((l) => l.itemIndexes.includes(index))
            .map((l) => this.name(l.debtorPubkey)),
        ],
      }))
      .filter((it) => only === undefined || only.includes(it.index));
  }

  expenses(): ExpenseView[] {
    return [...this.trip.expenses.values()]
      .sort((a, b) => b.seq - a.seq)
      .map((e) => this.expense(e));
  }

  expense(e: ExpenseRecord): ExpenseView {
    const lines = [...this.trip.lines.values()].filter((l) => l.expenseEventHash === e.eventHash);
    const { body } = e;
    return {
      expenseId: body.expenseId,
      eventHash: e.eventHash,
      payer: this.name(e.payerPubkey),
      submittedAt: e.submittedAt.toISOString(),
      merchant: body.receipt.merchant,
      date: body.receipt.date,
      currency: body.receipt.currency,
      receiptTotal: body.receipt.total,
      rate: body.rate,
      totalUsdCents: body.totalUsdCents,
      payerCents: body.payerCents,
      items: this.items(e),
      lines: lines.map((l) => this.line(l)),
      status: e.voided ? 'voided' : lines.every(isFinal) ? 'settled' : 'open',
      receiptImageSha256: body.receiptImageSha256,
      warnings: [...body.receipt.warnings],
    };
  }

  guaranteeLeft(pubkey: string): bigint {
    const used = this.trip.members.get(pubkey)?.guaranteeUsedCents ?? 0n;
    const left = this.trip.params.guaranteeCapCents - used;
    return left > 0n ? left : 0n;
  }

  coordinator(): CoordinatorView {
    // dave's agent knows the liquidity it opened after the first channel (B9); the margin
    // does not depend on the threshold.
    const needs =
      this.agent instanceof CoordinatorAgent
        ? this.agent.liquidityNeeds(this.trip)
        : liquidityPlan(this.trip, 0n);
    const margins = new Map(needs.map((n) => [n.memberPubkey, n.marginCents]));
    return {
      members: [...this.trip.members.values()].map((m) => ({
        memberId: m.memberId,
        guaranteeUsedCents: m.guaranteeUsedCents,
        guaranteeLeftCents: this.guaranteeLeft(m.pubkey),
        // What the operator paid for this member is what it recovers off-platform (SPEC §6.7).
        operatorCreditCents: m.guaranteeUsedCents,
        liquidityMarginCents: margins.get(m.pubkey) ?? null,
      })),
      disputes: this.sortedLines((l) => l.state === 'contested').map((l) => {
        const e = this.trip.expenses.get(l.expenseEventHash)!;
        return {
          expenseId: l.expenseId,
          expenseEventHash: l.expenseEventHash,
          payer: this.name(l.payerPubkey),
          debtor: this.name(l.debtorPubkey),
          cents: l.cents,
          reason: l.contestReason ?? '',
          contestedAt: (l.contestedAt ?? e.submittedAt).toISOString(),
          merchant: e.body.receipt.merchant,
          currency: e.body.receipt.currency,
          items: this.items(e, l.itemIndexes),
          receiptImageSha256: e.body.receiptImageSha256,
        };
      }),
      defaults: this.trip.defaults.map((l) => {
        const left = this.guaranteeLeft(l.debtorPubkey);
        return {
          expenseId: l.expenseId,
          expenseEventHash: l.expenseEventHash,
          payer: this.name(l.payerPubkey),
          debtor: this.name(l.debtorPubkey),
          cents: l.cents,
          overdueSince: (l.overdueAt ?? this.now).toISOString(),
          debtorExcluded: this.trip.members.get(l.debtorPubkey)?.excluded ?? false,
          guaranteeLeftCents: left,
          coverable: l.cents <= left,
        };
      }),
    };
  }

  /** The agent's own decisions plus one row per event of the log, newest first. */
  activity(): ActivityItem[] {
    const rows = this.agent.log.events
      .map((e) => this.eventRow(e))
      .filter((r): r is ActivityItem => r !== null);
    return [...this.agent.activity(), ...rows].sort((a, b) => b.at.localeCompare(a.at));
  }

  private eventRow(e: StoredEvent): ActivityItem | null {
    const { inner } = e.signed;
    const at = e.receivedAt;
    const who = (pubkey: string) =>
      this.names.get(pubkey) ?? (pubkey === this.trip.coordinatorPubkey ? 'dave' : 'someone');
    const expense = (hash: string) => this.trip.expenses.get(hash)?.body.expenseId ?? null;
    const row = (text: string, expenseId: string | null = null, proof: ProofRef | null = null) => ({
      at,
      kind: inner.type,
      text,
      expenseId,
      proof,
    });
    switch (inner.type) {
      case 'TRIP_CREATED':
        return row(`dave created the trip "${inner.body.name}"`);
      case 'RATE_SET':
        return row(`dave set the rate of the day (${inner.body.source}, ${inner.body.asOf})`);
      case 'MEMBER_JOINED':
        return row(`${inner.body.memberId} joined the trip`);
      case 'MEMBER_ADMITTED':
        return row(`dave admitted ${who(inner.body.memberPubkey)}`);
      case 'CHANNELS_READY':
        return row(`${who(inner.body.memberPubkey)}'s channels with the operator are open`);
      case 'EXPENSE_SUBMITTED':
        return row(
          `${who(inner.author)} paid ${inner.body.receipt.merchant}: ${formatCents(inner.body.totalUsdCents)} split in ${inner.body.lines.length + 1}`,
          inner.body.expenseId,
        );
      case 'LINE_DECIDED':
        return row(
          inner.body.decision === 'approve'
            ? `${who(inner.author)} approved ${formatCents(inner.body.cents)}`
            : `${who(inner.author)} contested ${formatCents(inner.body.cents)}: "${inner.body.reason ?? ''}"`,
          expense(inner.body.expenseEventHash),
        );
      case 'PAYMENT_MADE':
        return row(
          `${who(inner.author)} paid ${formatCents(inner.body.cents)} to ${who(inner.body.creditorPubkey)}`,
          expense(inner.body.expenseEventHash),
          inner.body.rail === 'ln'
            ? { rail: 'ln', paymentHash: inner.body.paymentHash }
            : { rail: 'onchain', txid: inner.body.txid },
        );
      case 'EXPENSE_VOIDED':
        return row(`${who(inner.author)} voided an expense`, expense(inner.body.expenseEventHash));
      case 'DISPUTE_RESOLVED': {
        const outcome = {
          upheld: 'upheld the line',
          line_voided: 'voided the line',
          expense_voided: 'voided the whole expense',
        }[inner.body.outcome];
        return row(
          `dave ${outcome} of ${who(inner.body.debtorPubkey)}${inner.body.note ? `: ${inner.body.note}` : ''}`,
          expense(inner.body.expenseEventHash),
        );
      }
      case 'GUARANTEE_PAID':
        return row(
          `The operator covered ${formatCents(inner.body.cents)} for ${who(inner.body.debtorPubkey)} to ${who(inner.body.creditorPubkey)}`,
          expense(inner.body.expenseEventHash),
          { rail: 'ln', paymentHash: inner.body.paymentHash },
        );
      case 'MEMBER_EXCLUDED':
        return row(`dave excluded ${who(inner.body.memberPubkey)}: ${inner.body.reason}`);
      case 'TRIP_CLOSED':
        return row('dave closed the trip');
      // Bookkeeping, not activity: shown in "Ledger verified" instead.
      case 'LINE_SEEN':
      case 'INVOICE_REISSUED':
      case 'POLICY_UPDATED':
      case 'CHECKPOINT':
        return null;
    }
  }
}

function proofRef(l: LineRecord): ProofRef | null {
  const p = l.payment;
  if (p === null) return null;
  if (p.by === 'debtor' && p.rail === 'onchain') return { rail: 'onchain', txid: p.txid };
  return { rail: 'ln', paymentHash: p.paymentHash };
}
