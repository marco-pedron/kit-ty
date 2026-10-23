// OWNED BY STREAM C (task C3): GET /api/:as/state and the proof panel with KITTY_REGISTRY=v2
// (23/10). The TripView is built from the traveler's own registry v2 (RegistryAgent), never
// from the legacy log; dave is only the LSP and gets his operations, no trip. Same TripView
// as v1, so the UI renders both: v2 adds `group` (votes), `manualOnly` and the `left` status.
import {
  formatUnits,
  isMemberId,
  roleOf,
  sha256Hex,
  type ActivityItem,
  type AiStatus,
  type ActorId,
  type BalanceView,
  type Check,
  type ExpenseItemView,
  type ExpenseView,
  type LedgerHealth,
  type LineView,
  type MemberId,
  type MemberView,
  type MeView,
  type ProofView,
  type TripView,
  type registry as fmt,
} from '@kitty/shared';
import { hexToBytes, registry as v2 } from '@kitty/ledger';
import type { RegistryAgent } from '../flows/registry-agent.js';
import type { RegistryRuntime } from '../flows/runtime.js';
import type { WalletBalances } from '../wallet/types.js';

type Trip = v2.RegistryTrip;
type Line = v2.RegistryLine;

export interface RegistryStateInput {
  as: ActorId;
  rt: RegistryRuntime;
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

const isoSec = (s: number | null) => (s === null ? null : new Date(s * 1000).toISOString());

export function buildRegistryTripView(input: RegistryStateInput): TripView {
  const { as, rt, now } = input;
  const agent = isMemberId(as) ? (rt.travelers.get(as) ?? null) : null;
  const trip = agent?.view() ?? null;
  const ctx = agent !== null && trip !== null ? new RegistryViewContext(trip, agent, now) : null;
  const me = ctx?.meView(input.balances, rt) ?? null;
  return {
    as,
    role: roleOf(as),
    fakes: input.fakes,
    registry: 'v2',
    serverNow: now.toISOString(),
    trip:
      trip === null
        ? null
        : {
            tripId: trip.tripId,
            name: trip.name,
            assetId: trip.params.assetId,
            status: trip.finished ? 'closed' : 'open',
            params: { ...rt.params, silentAssentSeconds: trip.params.silentAssentSeconds },
          },
    rate: agent?.savedRate() ?? null,
    members: ctx?.members() ?? [],
    me: isMemberId(as)
      ? (me ?? {
          memberId: as,
          policy: agent?.policy() ?? defaultPolicy,
          balance: null,
          oweCents: 0n,
          owedToMeCents: 0n,
          autoPaidTodayCents: 0n,
          debts: [],
          credits: [],
        })
      : null,
    // No coordinator with v2: dave is only the LSP.
    coordinator: null,
    expenses: ctx?.expenses() ?? [],
    activity: ctx?.activity() ?? [
      ...(as === 'dave' ? rt.lsp.activity() : (agent?.activity() ?? [])),
    ],
    operations: [...(as === 'dave' ? rt.lsp.operations() : (agent?.operations() ?? []))],
    ai: { status: input.ai ?? 'loading', fake: input.fakes },
    ledger: ctx?.health() ?? EMPTY_HEALTH,
    explorerBaseUrl: input.explorerBaseUrl,
  };
}

const defaultPolicy = { autoPayLimitCents: 2000n, dailyCapCents: 6000n, payUpheldDisputes: false };

/** The LineView of one line after an action, as `agent` sees it now. */
export function registryLineView(agent: RegistryAgent, line: Line, now: Date): LineView {
  const trip = agent.view();
  if (trip === null) throw new Error('no trip yet');
  return new RegistryViewContext(trip, agent, now).line(trip.lines.get(line.key) ?? line);
}

/** The ExpenseView of one expense by its expense id; null if unknown. */
export function registryExpenseView(
  agent: RegistryAgent,
  expenseId: string,
  now: Date,
): ExpenseView | null {
  const trip = agent.view();
  if (trip === null) return null;
  const ref = [...trip.expenses].find(([, x]) => x.body.proposal.expenseId === expenseId)?.[0];
  return ref === undefined ? null : new RegistryViewContext(trip, agent, now).expense(ref);
}

class RegistryViewContext {
  constructor(
    readonly trip: Trip,
    readonly agent: RegistryAgent,
    readonly now: Date,
  ) {}

  name(pubkey: string): MemberId {
    return this.agent.nameOf(this.trip, pubkey) as MemberId;
  }

  private get me(): v2.RegistryMember | null {
    return this.agent.me(this.trip);
  }

  members(): MemberView[] {
    const me = this.me?.pubkey;
    return [...this.trip.members.values()].map((m) => ({
      memberId: m.displayName as MemberId,
      displayName: m.displayName,
      pubkey: m.pubkey,
      nodePubkey: m.nodePubkey,
      status: m.left ? 'left' : m.excluded ? 'excluded' : 'active',
      closingTxids: m.pubkey === me ? [...(this.agent.closingTxids() ?? [])] : [],
      registry: { blockedByMe: me !== undefined && m.blockedBy.includes(me), excluded: m.excluded },
    }));
  }

  meView(balances: WalletBalances | null, rt: RegistryRuntime): MeView | null {
    const me = this.me;
    if (me === null) return null;
    const lines = [...this.trip.lines.values()];
    const open = (l: Line) => v2.lineIsOpen(this.trip, l.key);
    const sum = (ls: Line[]) => ls.reduce((a, l) => a + l.amount, 0n);
    return {
      memberId: me.displayName as MemberId,
      policy: this.agent.policy(this.trip),
      balance: balanceView(rt, balances),
      oweCents: sum(lines.filter((l) => l.debtor === me.pubkey && open(l))),
      owedToMeCents: sum(lines.filter((l) => l.payer === me.pubkey && open(l))),
      autoPaidTodayCents: v2.autoPaidLast24h(
        this.trip,
        me.pubkey,
        v2.unixSeconds(this.now.toISOString()),
      ),
      debts: this.sorted((l) => l.debtor === me.pubkey).map((l) => this.line(l)),
      credits: this.sorted((l) => l.payer === me.pubkey).map((l) => this.line(l)),
    };
  }

  private createdAt(ref: string): number {
    return this.trip.fold.expenses.get(ref)?.createdAt ?? 0;
  }

  /** Newest expense first, then in the order of the expense's lines. */
  private sorted(pick: (l: Line) => boolean): Line[] {
    return [...this.trip.lines.values()]
      .filter(pick)
      .sort((a, b) => this.createdAt(b.expenseRef) - this.createdAt(a.expenseRef));
  }

  line(l: Line): LineView {
    const expense = this.trip.expenses.get(l.expenseRef);
    const bolt11 = l.invoice ?? l.invoices.at(-1) ?? '';
    const invoice = this.agent.registry.invoice(bolt11);
    const expiresAt =
      invoice?.expiresAt ??
      new Date(
        (this.createdAt(l.expenseRef) + this.trip.params.invoiceExpirySeconds) * 1000,
      ).toISOString();
    const me = this.me?.pubkey;
    const record = this.trip.fold.lines.get(l.key);
    const p = l.payment;
    return {
      expenseId: expense?.body.proposal.expenseId ?? l.expenseRef.slice(0, 12),
      expenseEventHash: l.expenseRef,
      payer: this.name(l.payer),
      debtor: this.name(l.debtor),
      cents: l.amount,
      itemIndexes: [...l.itemIndexes],
      // manual_only is a due line payable by hand only: `manualOnly` says why.
      state: l.state === 'manual_only' ? 'due' : l.state,
      seenAt: isoSec(l.seenAt),
      deadlineAt: isoSec(l.deadlineAt),
      contestReason: l.contestReason,
      resolution: null,
      agent: this.agent.decisionFor(l, this.trip),
      paidBy: p === null ? null : 'debtor',
      proof:
        p === null
          ? null
          : p.rail === 'ln'
            ? { rail: 'ln', paymentHash: p.paymentHash ?? '' }
            : { rail: 'onchain', txid: p.txid ?? '' },
      invoiceExpiresAt: expiresAt,
      group:
        l.group === null
          ? null
          : {
              voters: l.group.voters.map((x) => this.name(x)),
              due: l.group.due.map((x) => this.name(x)),
              voided: l.group.voided.map((x) => this.name(x)),
              outcome: l.group.outcome,
              canVote:
                me !== undefined &&
                record !== undefined &&
                v2.voteRefusal(this.trip.fold, record, me) === null,
            },
      manualOnly: l.manualOnly,
    };
  }

  items(ref: string, only?: readonly number[]): ExpenseItemView[] {
    const x = this.trip.expenses.get(ref);
    if (x === undefined) return [];
    const p = x.body.proposal;
    return p.receipt.items
      .map((it, index) => ({
        index,
        label: it.label,
        quantity: it.quantity,
        total: it.total,
        members: [
          ...(p.payerItemIndexes.includes(index) ? [this.name(x.payer)] : []),
          ...p.lines.filter((l) => l.itemIndexes.includes(index)).map((l) => this.name(l.debtor)),
        ],
      }))
      .filter((it) => only === undefined || only.includes(it.index));
  }

  expenses(): ExpenseView[] {
    return [...this.trip.expenses.keys()]
      .sort((a, b) => this.createdAt(b) - this.createdAt(a))
      .map((ref) => this.expense(ref));
  }

  expense(ref: string): ExpenseView {
    const x = this.trip.expenses.get(ref);
    if (x === undefined) throw new Error(`no expense ${ref.slice(0, 8)}…`);
    const p = x.body.proposal;
    const lines = [...this.trip.lines.values()].filter((l) => l.expenseRef === ref);
    const voided = (this.trip.fold.expenses.get(ref)?.voids.length ?? 0) > 0;
    const final = (l: Line) => l.state === 'paid' || l.state === 'voided';
    const duplicate =
      x.possibleDuplicateOf.length > 0
        ? ['Possible duplicate: another expense has the same receipt (C10). Contest the wrong one.']
        : [];
    return {
      expenseId: p.expenseId,
      eventHash: ref,
      payer: this.name(x.payer),
      submittedAt: new Date(this.createdAt(ref) * 1000).toISOString(),
      merchant: p.receipt.merchant,
      date: p.receipt.date,
      currency: p.receipt.currency,
      receiptTotal: p.receipt.total,
      rate: p.rate.value,
      totalUsdCents: p.total,
      payerCents: p.payerAmount,
      items: this.items(ref),
      lines: lines.map((l) => this.line(l)),
      status: voided && lines.every(final) ? 'voided' : lines.every(final) ? 'settled' : 'open',
      receiptImageSha256: x.body.receiptImageSha256,
      warnings: [...p.receipt.warnings, ...duplicate],
    };
  }

  /** "Ledger verified" on the registry: events held, all verified; DAG complete. */
  health(): LedgerHealth {
    const held = this.agent.registry.allEvents().length;
    return {
      events: held,
      validSignatures: held - this.trip.rejected.length,
      chainValid: this.trip.waiting.length === 0 && this.trip.rejected.length === 0,
      headSeq: this.trip.count,
      headHash: this.trip.stateHash,
      // Compared through CHECKPOINT with step 4 (relays): not yet.
      checkpoints: null,
    };
  }

  /** The agent's own decisions plus one row per valid registry event, newest first. */
  activity(): ActivityItem[] {
    const rejected = new Set(this.trip.rejected.map((r) => r.id));
    const rows = this.agent.registry
      .allEvents()
      .filter((e) => !rejected.has(e.id))
      .map((e) => this.eventRow(e))
      .filter((r): r is ActivityItem => r !== null);
    return [...this.agent.activity(), ...rows].sort((a, b) => b.at.localeCompare(a.at));
  }

  private amount(x: bigint): string {
    return formatUnits(x, this.trip.params.assetDecimals, this.trip.params.displayDecimals);
  }

  private eventRow(e: fmt.RegistryEvent): ActivityItem | null {
    const c = e.content;
    const who = (pk: string) => this.agent.nameOf(this.trip, pk);
    const expenseId = (ref: string) => this.trip.expenses.get(ref)?.body.proposal.expenseId ?? null;
    const row = (text: string, x: string | null = null, proof: ActivityItem['proof'] = null) => ({
      at: new Date(e.createdAt * 1000).toISOString(),
      kind: c.type,
      text,
      expenseId: x,
      proof,
    });
    switch (c.type) {
      case 'TRIP_CREATED':
        return row(`${who(e.author)} created the trip "${c.body.name}"`);
      case 'MEMBER_JOINED':
        return row(`${c.body.displayName} joined the trip`);
      case 'MEMBER_INVITED':
        return row(`${who(e.author)} invited someone`);
      case 'EXPENSE_SUBMITTED':
        return row(
          `${who(e.author)} paid ${c.body.proposal.receipt.merchant}: ${this.amount(c.body.proposal.total)} split in ${c.body.proposal.lines.length + 1}`,
          c.body.proposal.expenseId,
        );
      case 'LINE_DECIDED':
        return row(
          c.body.decision === 'approve'
            ? `${who(e.author)} approved ${this.amount(c.body.amount)}`
            : `${who(e.author)} contested ${this.amount(c.body.amount)}: "${c.body.reason ?? ''}"`,
          expenseId(c.body.expenseRef),
        );
      case 'LINE_VOTED':
        return row(
          `${who(e.author)} voted that ${who(c.body.debtor)}'s line is ${c.body.outcome === 'due' ? 'due' : 'voided'}`,
          expenseId(c.body.expenseRef),
        );
      case 'PAYMENT_MADE':
        return row(
          `${who(e.author)} paid ${this.amount(c.body.amount)} to ${who(c.body.creditor)}`,
          expenseId(c.body.expenseRef),
          c.body.rail === 'ln'
            ? { rail: 'ln', paymentHash: c.body.paymentHash }
            : { rail: 'onchain', txid: c.body.txid },
        );
      case 'EXPENSE_VOIDED':
        return row(`${who(e.author)} voided an expense`, expenseId(c.body.expenseRef));
      case 'MEMBER_BLOCKED':
        return row(`${who(e.author)} blocked ${who(c.body.target)}`);
      case 'MEMBER_UNBLOCKED':
        return row(`${who(e.author)} unblocked ${who(c.body.target)}`);
      case 'MEMBER_LEFT':
        return row(`${who(e.author)} left the trip and closed their channels`);
      // Bookkeeping, not activity.
      case 'TRIP_SECRET_SHARED':
      case 'LINE_SEEN':
      case 'INVOICE_REISSUED':
      case 'POLICY_UPDATED':
      case 'CHECKPOINT':
        return null;
    }
  }
}

function balanceView(rt: RegistryRuntime, b: WalletBalances | null): BalanceView | null {
  if (b === null) return null;
  const d = rt.params.tripChannelCents;
  return {
    tripOutboundCents: b.tripOutboundCents,
    inboundCents: b.inboundCents,
    onchainCents: b.onchainCents,
    tripChannelCents: d,
    topupWarning: b.tripOutboundCents * 100n < d * BigInt(rt.params.topupWarnPercent),
  };
}

// ---------- proof panel (SPEC §10.2) ----------

const check = (ok: boolean, label: string, detail: string): Check => ({ ok, label, detail });
const short = (hex: string) => `${hex.slice(0, 8)}…${hex.slice(-4)}`;

/**
 * The proof of a payment from the registry v2 of whichever traveler holds it (the creditor's
 * first: its node decoded the invoice). Recomputed, never trusted. Null if no paid line has it.
 */
export function buildRegistryProof(rt: RegistryRuntime, hash: string): ProofView | null {
  const agents = [...rt.travelers.values()];
  for (const agent of agents) {
    const trip = agent.view();
    if (trip === null) continue;
    const line = [...trip.lines.values()].find((l) => l.payment?.paymentHash === hash);
    if (line === undefined || line.payment === null) continue;
    // Prefer the creditor's phone, whose node made and decoded the invoice.
    const creditorAgent =
      agents.find((a) => a.registry.pubkey === line.payer && a.view() !== null) ?? agent;
    return proofOf(creditorAgent, creditorAgent.view() ?? trip, line, hash);
  }
  return null;
}

function proofOf(agent: RegistryAgent, trip: Trip, line: Line, hash: string): ProofView | null {
  const p = line.payment;
  const creditor = trip.members.get(line.payer);
  if (p === null || p.preimage === null || creditor === undefined) return null;
  const invoice =
    line.invoices
      .map((b) => agent.registry.invoice(b))
      .find((i) => i !== undefined && i.paymentHash === hash) ?? null;
  const computed = sha256Hex(hexToBytes(p.preimage));
  const preimageOk = computed === hash;
  const payeeOk = invoice !== null && invoice.payeePubkey === creditor.nodePubkey;
  const amountOk =
    invoice !== null && invoice.cents === line.amount && invoice.assetId === trip.params.assetId;
  const name = creditor.displayName;
  const checks = {
    preimageMatchesHash: check(
      preimageOk,
      'sha256(preimage) = payment hash',
      `sha256(${short(p.preimage)}) = ${short(computed)}${preimageOk ? '' : `, expected ${short(hash)}`}`,
    ),
    invoiceSignedByCreditor: check(
      payeeOk,
      `Invoice signed by ${name}'s node`,
      invoice === null
        ? 'the invoice is not decoded on this device yet'
        : `payee ${short(invoice.payeePubkey)}, ${name}'s node (bound with kitty-bind:v2) is ${short(creditor.nodePubkey)}`,
    ),
    amountMatches: check(
      amountOk,
      'Amount and asset match the line',
      invoice === null
        ? 'the invoice is not decoded on this device yet'
        : `invoice for ${invoice.cents ?? 'no'} units of ${invoice.assetId === trip.params.assetId ? 'the trip asset' : (invoice.assetId ?? 'no asset')}, line ${line.amount}`,
    ),
  };
  return {
    rail: 'ln',
    paymentHash: hash,
    preimage: p.preimage,
    cents: line.amount,
    payeePubkey: invoice?.payeePubkey ?? creditor.nodePubkey,
    expenseId: trip.expenses.get(line.expenseRef)?.body.proposal.expenseId ?? '',
    creditor: name as MemberId,
    debtor: agent.nameOf(trip, line.debtor) as MemberId,
    paidBy: 'debtor',
    checks,
    verified: preimageOk && payeeOk && amountOk,
  };
}
