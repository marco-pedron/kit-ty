import {
  formatUnits,
  type ActivityItem,
  type ApiError,
  type AutoPayDecision,
  type EventBody,
  type MemberId,
  type OperationView,
  type PaymentProof,
  type Policy,
  type Receipt,
  type SplitAssignment,
  type SplitPreview,
} from '@kitty/shared';
import { expenseFingerprint, expenseShares, LedgerError, registry as v2 } from '@kitty/ledger';
import type { RelayClient } from '../relay/types.js';
import type { Wallet, WalletBalances } from '../wallet/types.js';
import { FlowError, apiErrorOf } from './errors.js';
import { toV2Policy, type RegistryV2 } from './registry-v2.js';

// The agent of one traveler with KITTY_REGISTRY=v2 (23/10): it reads and writes ONLY the
// registry v2. No coordinator: whoever pays submits, the debtors' agents see, decide and pay,
// a contest is withdrawn by the debtor (C3) or decided by the other members (vote), and each
// member leaves by closing its own channels with the LSP. The trip is closed when everyone
// has left. The money rules are the ledger's (deriveRegistry, decideRegistryAutoPay); this
// loop only acts on them. Backups go to the relay as in v1 (SPEC §12); the registry never does.

/** The rate this phone saved last (infra/rates.json in the demo; step 5 brings the oracle). */
export type SavedRate = EventBody<'RATE_SET'>;

export interface RegistryAgentOptions {
  actor: MemberId;
  wallet: Wallet;
  registry: RegistryV2;
  /** Only for the encrypted backups of the node (SPEC §12). */
  relay: Pick<RelayClient, 'putBackup'>;
  rate: () => SavedRate;
  /** The LSP node this member's channels are open with: closed when the member leaves. */
  lspNodePubkey: () => Promise<string>;
  now?: () => Date;
  /** A failed payment, publish or close is retried after this (default 10 s). */
  retryMs?: number;
  /** Back the node up once quiet this long after a change (SPEC §12); unset: never. */
  backupQuietMs?: number;
}

type Line = v2.RegistryLine;
type Trip = v2.RegistryTrip;

const MAX_KEPT = 50;
const OPEN = (l: Line) => l.state !== 'paid' && l.state !== 'voided';
const newExpenseId = () =>
  `x${[...crypto.getRandomValues(new Uint8Array(6))].map((b) => b.toString(16).padStart(2, '0')).join('')}`;
/** A saved rate's day ("2026-10-17") as the instant the proposal wants. */
const rateInstant = (d: string) => (/^\d{4}-\d{2}-\d{2}$/u.test(d) ? `${d}T00:00:00.000Z` : d);

export interface ExpensePlanV2 {
  rate: SavedRate;
  value: string;
  shares: ReturnType<typeof expenseShares>;
  payerItemIndexes: number[];
  debtors: { member: v2.RegistryMember; itemIndexes: number[]; amount: bigint }[];
}

export interface LeaveResult {
  closingTxids: string[];
  /** Set when the member left with money still owed to it: from now on paid on-chain only. */
  warning: string | null;
}

export class RegistryAgent {
  readonly actor: MemberId;
  readonly registry: RegistryV2;
  private readonly lspNodePubkey: () => Promise<string>;
  private readonly wallet: Wallet;
  private readonly relay: Pick<RelayClient, 'putBackup'>;
  private readonly rate: () => SavedRate;
  readonly now: () => Date;
  private readonly retryMs: number;
  private readonly backupQuietMs: number | null;

  private ticking = false;
  private paying: Promise<void> | null = null;
  private backingUp: Promise<void> | null = null;
  /** Intents in flight or done, by `${type}:${line key}`, until the registry shows them. */
  private readonly sent = new Set<string>();
  /** Paid, PAYMENT_MADE not in the registry yet: never pay twice. */
  private readonly proofs = new Map<string, { line: Line; proof: PaymentProof }>();
  private readonly retryAt = new Map<string, number>();
  private readonly decisions = new Map<string, string>();
  private readonly activityItems: ActivityItem[] = [];
  private readonly ops: OperationView[] = [];
  private opCounter = 0;
  /** When the node last changed and was not backed up since; null when the backup is current. */
  private dirtySince: number | null;
  private receivedCount = 0;
  /** After MEMBER_LEFT: the closing txids once the channels are closed, null until then. */
  private closed: string[] | null = null;
  private closeRetryAt = 0;

  constructor(o: RegistryAgentOptions) {
    this.actor = o.actor;
    this.wallet = o.wallet;
    this.registry = o.registry;
    this.relay = o.relay;
    this.rate = o.rate;
    this.lspNodePubkey = o.lspNodePubkey;
    this.now = o.now ?? (() => new Date());
    this.retryMs = o.retryMs ?? 10_000;
    this.backupQuietMs = o.backupQuietMs ?? null;
    this.dirtySince = this.now().getTime();
  }

  // ---------- reading (for the routes) ----------

  private nowSec(): number {
    return v2.unixSeconds(this.now().toISOString());
  }

  /** The trip as this phone derives it from the registry events it holds, now. */
  view(): Trip | null {
    return this.registry.view(this.now());
  }

  /** This member in the registry; null before joining. */
  me(trip: Trip | null = this.view()): v2.RegistryMember | null {
    const pk = this.registry.pubkey;
    return pk === null ? null : (trip?.members.get(pk) ?? null);
  }

  /** The member whose display name is `id` (alice, bob, charlie in the demo). */
  memberNamed(trip: Trip, id: string): v2.RegistryMember | undefined {
    return [...trip.members.values()].find((m) => m.displayName === id);
  }

  nameOf(trip: Trip, pubkey: string): string {
    return trip.members.get(pubkey)?.displayName ?? `${pubkey.slice(0, 8)}…`;
  }

  /** The policy in the shape the UI edits (no payUpheldDisputes: no coordinator upholds). */
  policy(trip: Trip | null = this.view()): Policy {
    const p = this.me(trip)?.policy;
    return {
      autoPayLimitCents: p?.autoPayLimit ?? 2000n,
      dailyCapCents: p?.dailyCap ?? 6000n,
      payUpheldDisputes: false,
    };
  }

  amount(trip: Trip, x: bigint): string {
    return formatUnits(x, trip.params.assetDecimals, trip.params.displayDecimals);
  }

  /** What this agent decides for one of its own lines, and why; null on others' lines. */
  decisionFor(line: Line, trip: Trip | null = this.view()): AutoPayDecision | null {
    const me = this.registry.pubkey;
    if (trip === null || me === null || line.debtor !== me) return null;
    if (this.proofs.has(line.key))
      return {
        pay: false,
        reason: `Paid ${this.amount(trip, line.amount)}: publishing the proof.`,
      };
    const p = this.me(trip)?.policy ?? { autoPayLimit: 0n, dailyCap: 0n };
    const invoice = line.invoice === null ? null : (this.registry.invoice(line.invoice) ?? null);
    return v2.decideRegistryAutoPay(p, line, trip, this.nowSec(), invoice);
  }

  /** My own node only (SPEC §1); null while it does not answer. */
  async balances(): Promise<WalletBalances | null> {
    const timeout = new Promise<null>((r) => setTimeout(() => r(null), 1_500));
    return Promise.race([this.wallet.balances().catch(() => null), timeout]);
  }

  activity(): readonly ActivityItem[] {
    return this.activityItems;
  }

  operations(): readonly OperationView[] {
    return this.ops;
  }

  /** The rate this phone saved last, used for the next expense. */
  savedRate(): SavedRate {
    return this.rate();
  }

  /** The closing txids of my channels after leaving; null before. */
  closingTxids(): readonly string[] | null {
    return this.closed;
  }

  async idle(): Promise<void> {
    while (this.paying !== null || this.backingUp !== null) await (this.paying ?? this.backingUp);
  }

  // ---------- the loop ----------

  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      await this.step();
    } finally {
      this.ticking = false;
    }
  }

  private async step(): Promise<void> {
    await this.registry.sync();
    const trip = this.view();
    const me = this.me(trip);
    if (trip === null || me === null) return;
    await this.markSeen(trip, me.pubkey);
    await this.publishProofs(trip);
    this.maybePay(trip, me.pubkey);
    if (!me.left) await this.reissueExpired(trip, me.pubkey);
    if (me.left) await this.closeChannels();
    this.noteReceived(trip, me.pubkey);
    await this.maybeBackup();
  }

  private async markSeen(trip: Trip, me: string): Promise<void> {
    for (const line of trip.lines.values()) {
      if (line.debtor !== me || line.state !== 'submitted') continue;
      await this.once(`LINE_SEEN:${line.key}`, () =>
        this.publishOk('LINE_SEEN', { expenseRef: line.expenseRef }),
      );
    }
  }

  /** One payment at a time (SPEC §10.1). */
  private maybePay(trip: Trip, me: string): void {
    if (this.paying !== null) return;
    const now = this.now().getTime();
    for (const line of trip.lines.values()) {
      if (line.debtor !== me || line.state !== 'due') continue;
      if (this.proofs.has(line.key) || (this.retryAt.get(line.key) ?? 0) > now) continue;
      const decision = this.decisionFor(line, trip);
      if (decision === null) continue;
      this.noteDecision(line, decision);
      if (!decision.pay || line.invoice === null) continue;
      this.paying = this.pay(trip, line, line.invoice, decision).finally(() => {
        this.paying = null;
      });
      return;
    }
  }

  private async pay(trip: Trip, line: Line, bolt11: string, d: AutoPayDecision): Promise<void> {
    const to = this.nameOf(trip, line.payer);
    const amount = this.amount(trip, line.amount);
    const op = this.startOp('paying', `Paying ${amount} to ${to} through the LSP…`);
    try {
      const proof = await this.wallet.pay(bolt11);
      this.proofs.set(line.key, { line, proof });
      this.markNodeChanged();
      this.endOp(op, 'done');
      this.addActivity(
        `Your agent paid ${amount} to ${to}: ${d.reason.replace(/^Paying [^:]*: /, '')}`,
        trip,
        line,
        proof,
      );
      await this.publishProofs(this.view() ?? trip);
    } catch (err) {
      this.retryAt.set(line.key, this.now().getTime() + this.retryMs);
      const e = apiErrorOf(err);
      this.endOp(op, 'failed', e);
      this.addActivity(
        `Payment of ${amount} to ${to} failed: ${e.message}. ${e.action}`,
        trip,
        line,
      );
    }
  }

  /** PAYMENT_MADE for every payment done but not in the registry yet; retried until it is. */
  private async publishProofs(trip: Trip): Promise<void> {
    for (const [key, { line, proof }] of this.proofs) {
      const current = trip.lines.get(key);
      if (current === undefined || !OPEN(current)) {
        this.proofs.delete(key);
        continue;
      }
      const intent = `PAYMENT_MADE:${key}`;
      if (this.sent.has(intent)) continue;
      this.sent.add(intent);
      const common = { expenseRef: line.expenseRef, creditor: line.payer, amount: line.amount };
      try {
        await this.publishOk(
          'PAYMENT_MADE',
          proof.rail === 'ln'
            ? { ...common, rail: 'ln', paymentHash: proof.paymentHash, preimage: proof.preimage }
            : { ...common, rail: 'onchain', txid: proof.txid },
        );
        this.proofs.delete(key);
      } catch {
        // Paid but not published: kept, published again on the next tick.
      } finally {
        this.sent.delete(intent);
      }
    }
  }

  /** As creditor: a fresh invoice when every invoice of an open line expired (C6). */
  private async reissueExpired(trip: Trip, me: string): Promise<void> {
    for (const line of trip.lines.values()) {
      if (line.payer !== me || !OPEN(line) || line.invoice !== null) continue;
      const last = line.invoices.at(-1) ?? '';
      await this.once(`INVOICE_REISSUED:${last}`, async () => {
        const bolt11 = await this.lineInvoice(trip, line.expenseRef, line.debtor, line.amount);
        await this.publishOk('INVOICE_REISSUED', {
          expenseRef: line.expenseRef,
          debtor: line.debtor,
          bolt11,
        });
      });
    }
  }

  /** Every new payment to me changes my node: back it up again. */
  private noteReceived(trip: Trip, me: string): void {
    const n = [...trip.lines.values()].filter((l) => l.payer === me && l.payment !== null).length;
    if (n !== this.receivedCount) this.markNodeChanged();
    this.receivedCount = n;
  }

  // ---------- backups (SPEC §12, as in v1) ----------

  private markNodeChanged(): void {
    this.dirtySince = this.now().getTime();
  }

  private async maybeBackup(): Promise<void> {
    if (this.backupQuietMs === null || this.backingUp !== null || this.dirtySince === null) return;
    if (this.now().getTime() - this.dirtySince < this.backupQuietMs) return;
    if (this.paying !== null || this.ops.some((o) => o.status === 'running')) return;
    this.dirtySince = null;
    const op = this.startOp('backing_up', 'Backing up your node to the relay (encrypted)…');
    this.backingUp = (async () => {
      try {
        const { blob } = await this.wallet.backupNow();
        await this.relay.putBackup(await this.wallet.nodePubkey(), blob);
        this.endOp(op, 'done');
      } catch (err) {
        this.dirtySince = this.now().getTime() - (this.backupQuietMs ?? 0) + this.retryMs;
        this.endOp(op, 'failed', apiErrorOf(err));
      }
    })().finally(() => {
      this.backingUp = null;
    });
  }

  // ---------- member actions (routes) ----------

  /**
   * From the receipt and the assignment to the shares, computed by the ledger with the rate
   * this phone saved (the LLM never computes money). Refused, with the reason, when the
   * registry would refuse it (expenseRefusal: blocks, exclusions, members who left).
   */
  planExpense(receipt: Receipt, assignments: readonly SplitAssignment[]): ExpensePlanV2 {
    const { trip, me } = this.requireMember();
    const rate = this.rate();
    const value = receipt.currency === 'USD' ? '1' : rate.rates[receipt.currency];
    if (value === undefined)
      throw new FlowError('MISSING_RATE', `no saved ${receipt.currency} rate on this phone`);
    const items = new Map<string, number[]>();
    const assigned = new Set<number>();
    for (const a of assignments) {
      if (a.itemIndex >= receipt.items.length)
        throw new FlowError('INVALID_ASSIGNMENT', `item ${a.itemIndex} is not on the receipt`);
      if (assigned.has(a.itemIndex))
        throw new FlowError('INVALID_ASSIGNMENT', `item ${a.itemIndex} is assigned twice`);
      assigned.add(a.itemIndex);
      for (const id of new Set(a.members)) {
        const m = this.memberNamed(trip, id);
        if (m === undefined || !v2.isActive(trip.fold, m.pubkey))
          throw new FlowError('UNKNOWN_PARTICIPANT', `${id} is not an active member of the trip`);
        items.set(m.pubkey, [...(items.get(m.pubkey) ?? []), a.itemIndex]);
      }
    }
    const missing = receipt.items.findIndex((_, i) => !assigned.has(i));
    if (missing >= 0) throw new FlowError('INVALID_ASSIGNMENT', `item ${missing} is not assigned`);
    const debtors = [...items]
      .filter(([pk]) => pk !== me.pubkey)
      .map(([pk, itemIndexes]) => ({
        member: trip.members.get(pk) as v2.RegistryMember,
        itemIndexes,
      }));
    if (debtors.length === 0)
      throw new FlowError('EMPTY_ALLOCATION', 'nobody else shares this expense');
    const refusal = v2.expenseRefusal(
      trip.fold,
      me.pubkey,
      debtors.map((d) => d.member.pubkey),
    );
    if (refusal !== null) throw new FlowError('NOT_ALLOWED', `Not sent: ${refusal}`);
    const payerItemIndexes = items.get(me.pubkey) ?? [];
    let shares: ReturnType<typeof expenseShares>;
    try {
      shares = expenseShares({
        receipt,
        rate: value,
        assetDecimals: trip.params.assetDecimals,
        payer: me.pubkey,
        payerItemIndexes,
        debtors: debtors.map((d) => ({ id: d.member.pubkey, itemIndexes: d.itemIndexes })),
      });
    } catch (err) {
      if (err instanceof LedgerError) throw new FlowError(err.code, err.message);
      throw err;
    }
    return {
      rate,
      value,
      shares,
      payerItemIndexes,
      debtors: debtors.map((d, i) => {
        const amount = shares.debtors[i]?.cents ?? 0n;
        if (amount === 0n)
          throw new FlowError(
            'EMPTY_ALLOCATION',
            `the share of ${d.member.displayName} rounds to 0`,
          );
        return { ...d, amount };
      }),
    };
  }

  /** POST /expenses/split: the shares per member, the payer included. */
  previewSplit(receipt: Receipt, assignments: readonly SplitAssignment[]): SplitPreview {
    const plan = this.planExpense(receipt, assignments);
    return {
      rate: plan.value,
      rateAsOf: plan.rate.asOf,
      totalUsdCents: plan.shares.totalUsdCents,
      shares: [
        { member: this.actor, cents: plan.shares.payerCents },
        ...plan.debtors.map((d) => ({ member: d.member.displayName as MemberId, cents: d.amount })),
      ],
    };
  }

  /** One invoice per debtor from my node, then EXPENSE_SUBMITTED. Returns the expense id. */
  async submitExpense(
    receipt: Receipt,
    assignments: readonly SplitAssignment[],
    receiptImageSha256: string,
  ): Promise<{ expenseId: string; eventId: string }> {
    await this.registry.sync();
    const plan = this.planExpense(receipt, assignments);
    const { trip, me } = this.requireMember();
    const expenseId = newExpenseId();
    const op = this.startOp(
      'submitting_expense',
      `Creating ${plan.debtors.length} invoices and signing the expense…`,
    );
    try {
      const invoices = [];
      for (const d of plan.debtors)
        invoices.push({
          debtor: d.member.pubkey,
          bolt11: await this.newInvoice(trip, expenseId, d.member, d.amount),
        });
      const e = await this.publishOk('EXPENSE_SUBMITTED', {
        proposal: {
          tripId: trip.tripId,
          expenseId,
          payer: me.pubkey,
          receipt,
          rate: {
            pair: `USD/${receipt.currency}`,
            value: plan.value,
            asOf: rateInstant(plan.rate.asOf),
            source: plan.rate.source,
          },
          assetId: trip.params.assetId,
          assetDecimals: trip.params.assetDecimals,
          total: plan.shares.totalUsdCents,
          payerAmount: plan.shares.payerCents,
          payerItemIndexes: plan.payerItemIndexes,
          lines: plan.debtors.map((d) => ({
            debtor: d.member.pubkey,
            amount: d.amount,
            itemIndexes: d.itemIndexes,
          })),
        },
        tableSignatures: [],
        invoices,
        receiptImageSha256,
        fingerprint: expenseFingerprint(receipt, receiptImageSha256),
      });
      this.markNodeChanged();
      this.endOp(op, 'done');
      return { expenseId, eventId: e.id };
    } catch (err) {
      this.endOp(op, 'failed', apiErrorOf(err));
      throw err;
    }
  }

  /** Approve or contest one of my lines; approving after a contest withdraws it (C3). */
  async decide(expenseId: string, decision: 'approve' | 'contest', reason?: string): Promise<Line> {
    await this.registry.sync();
    const { trip, me } = this.requireMember();
    const line = this.lineOf(trip, expenseId, me.pubkey);
    if (decision === 'contest' && reason === undefined)
      throw new FlowError('VALIDATION_ERROR', 'a contest needs a reason');
    await this.publishOk('LINE_DECIDED', {
      expenseRef: line.expenseRef,
      decision,
      amount: line.amount,
      ...(reason !== undefined && { reason }),
    });
    return this.lineOf(this.requireMember().trip, expenseId, me.pubkey);
  }

  /** My vote on someone else's contested line (23/10, provisional): due or voided. */
  async vote(expenseId: string, debtorId: string, outcome: v2.VoteOutcome): Promise<Line> {
    await this.registry.sync();
    const { trip, me } = this.requireMember();
    const debtor = this.memberNamed(trip, debtorId);
    if (debtor === undefined) throw new FlowError('NOT_FOUND', `${debtorId} is not in the trip`);
    const line = this.lineOf(trip, expenseId, debtor.pubkey);
    const record = trip.fold.lines.get(line.key);
    const refusal =
      record === undefined ? 'unknown line' : v2.voteRefusal(trip.fold, record, me.pubkey);
    if (refusal !== null) throw new FlowError('NOT_ALLOWED', refusal);
    await this.publishOk('LINE_VOTED', {
      expenseRef: line.expenseRef,
      debtor: debtor.pubkey,
      outcome,
    });
    return this.lineOf(this.requireMember().trip, expenseId, debtor.pubkey);
  }

  /** The payer voids an expense (C2: a paid line stays). */
  async voidExpense(expenseId: string): Promise<void> {
    await this.registry.sync();
    const { trip, me } = this.requireMember();
    const ref = this.expenseRef(trip, expenseId);
    if (trip.expenses.get(ref)?.payer !== me.pubkey)
      throw new FlowError('NOT_ALLOWED', 'only the payer can void an expense');
    await this.publishOk('EXPENSE_VOIDED', { expenseRef: ref });
  }

  async updatePolicy(policy: Policy): Promise<Policy> {
    await this.registry.sync();
    this.requireMember();
    await this.publishOk('POLICY_UPDATED', { policy: toV2Policy(policy) });
    return this.policy();
  }

  /** Block a member (D6, by pair); returns the warning the app shows (exclusion). */
  async blockMember(memberId: string): Promise<{ warning: string }> {
    const { trip, me, target } = await this.pair(memberId);
    const warning = v2.blockWarning(trip.fold, me.pubkey, target.pubkey);
    await this.publishOk('MEMBER_BLOCKED', { target: target.pubkey });
    return { warning };
  }

  /** Remove every block of mine on that member that I know (C7). */
  async unblockMember(memberId: string): Promise<void> {
    const { target } = await this.pair(memberId);
    await this.publishOk('MEMBER_UNBLOCKED', { target: target.pubkey });
  }

  /** What blocking that member would mean, before blocking. */
  async blockWarning(memberId: string): Promise<string> {
    const { trip, me, target } = await this.pair(memberId);
    return v2.blockWarning(trip.fold, me.pubkey, target.pubkey);
  }

  /**
   * Leaving the trip (23/10): MEMBER_LEFT, valid only without known debts (contested lines
   * count), then my own wallet closes my channels with the LSP. Nobody else decides it; the
   * trip is closed when every member has left. A failed close is retried by the loop.
   */
  async leave(): Promise<LeaveResult> {
    await this.registry.sync();
    const { trip, me } = this.requireMember();
    if (!me.left) {
      const debts = [...trip.lines.values()].filter(
        (l) => l.debtor === me.pubkey && v2.lineIsOpen(trip, l.key),
      );
      if (debts.length > 0)
        throw new FlowError(
          'NOT_ALLOWED',
          `You still owe ${debts.length} line(s), contested ones included: settle them before leaving.`,
        );
      await this.publishOk('MEMBER_LEFT', {});
    }
    const owed = [...trip.lines.values()].filter((l) => l.payer === me.pubkey && OPEN(l));
    const total = owed.reduce((a, l) => a + l.amount, 0n);
    await this.closeChannels(true);
    return {
      closingTxids: [...(this.closed ?? [])],
      warning:
        owed.length === 0
          ? null
          : `You are still owed ${this.amount(trip, total)}: with your channels closed, it can only be paid to you on-chain.`,
    };
  }

  /** After MEMBER_LEFT: closes my channels with the LSP, once; retried after retryMs. */
  private async closeChannels(now = false): Promise<void> {
    if (this.closed !== null) return;
    if (!now && this.now().getTime() < this.closeRetryAt) return;
    const op = this.startOp('closing_channels', 'Closing your channels with the LSP…');
    try {
      const { txids } = await this.wallet.closeChannelsWith(await this.lspNodePubkey());
      this.closed = txids;
      this.markNodeChanged();
      this.endOp(op, 'done');
      this.addActivity(`You left the trip: your ${txids.length} channels with the LSP are closed.`);
    } catch (err) {
      this.closeRetryAt = this.now().getTime() + this.retryMs;
      this.endOp(op, 'failed', apiErrorOf(err));
      if (now) throw err;
    }
  }

  // ---------- helpers ----------

  private async publishOk<T extends Parameters<RegistryV2['publish']>[0]>(
    type: T,
    body: Parameters<RegistryV2['publish']>[1] & {},
  ): Promise<Awaited<ReturnType<RegistryV2['publish']>>> {
    const e = await this.registry.publish(type, body as never);
    if (e.rejected !== null) throw new FlowError('INVALID_EVENT', `${type} refused: ${e.rejected}`);
    return e;
  }

  private async newInvoice(
    trip: Trip,
    expenseId: string,
    debtor: v2.RegistryMember,
    amount: bigint,
  ): Promise<string> {
    const { bolt11 } = await this.wallet.createInvoice({
      cents: amount,
      description: `kitty:${trip.tripId}:${expenseId}:${debtor.displayName}`,
      expirySec: this.registry.invoiceExpirySec() ?? trip.params.invoiceExpirySeconds,
    });
    await this.registry.decode(bolt11);
    return bolt11;
  }

  private async lineInvoice(trip: Trip, ref: string, debtor: string, amount: bigint) {
    const expenseId = trip.expenses.get(ref)?.body.proposal.expenseId ?? ref.slice(0, 8);
    const member = trip.members.get(debtor);
    if (member === undefined) throw new FlowError('NOT_FOUND', 'the debtor is not in the trip');
    return this.newInvoice(trip, expenseId, member, amount);
  }

  private async pair(memberId: string) {
    await this.registry.sync();
    const { trip, me } = this.requireMember();
    const target = this.memberNamed(trip, memberId);
    if (target === undefined) throw new FlowError('NOT_FOUND', `${memberId} is not in the trip`);
    return { trip, me, target };
  }

  requireMember(): { trip: Trip; me: v2.RegistryMember } {
    const trip = this.view();
    const me = this.me(trip);
    if (trip === null || me === null)
      throw new FlowError('AGENT_NOT_READY', `${this.actor} is not in the trip registry yet`);
    return { trip, me };
  }

  /** The registry id of my expense or anyone's with this expense id. */
  expenseRef(trip: Trip, expenseId: string): string {
    const ref = [...trip.expenses].find(([, x]) => x.body.proposal.expenseId === expenseId)?.[0];
    if (ref === undefined) throw new FlowError('NOT_FOUND', `no expense ${expenseId}`);
    return ref;
  }

  lineOf(trip: Trip, expenseId: string, debtor: string): Line {
    const line = trip.lines.get(v2.lineKey(this.expenseRef(trip, expenseId), debtor));
    if (line === undefined)
      throw new FlowError('NOT_FOUND', `no line of that member on ${expenseId}`);
    return line;
  }

  /** Runs an intent once: kept as sent on success, freed on failure so the next tick retries. */
  private async once(key: string, fn: () => Promise<unknown>): Promise<void> {
    if (this.sent.has(key)) return;
    this.sent.add(key);
    try {
      await fn();
    } catch (err) {
      this.sent.delete(key);
      this.addActivity(`Could not publish (${key.split(':')[0]}): ${apiErrorOf(err).message}`);
    }
  }

  private noteDecision(line: Line, d: AutoPayDecision): void {
    if (this.decisions.get(line.key) === d.reason) return;
    this.decisions.set(line.key, d.reason);
    if (!d.pay) this.addActivity(d.reason, this.view(), line);
  }

  private addActivity(
    text: string,
    trip: Trip | null = null,
    line: Line | null = null,
    proof: PaymentProof | null = null,
  ): void {
    this.activityItems.unshift({
      at: this.now().toISOString(),
      kind: 'AGENT',
      text,
      expenseId:
        line === null
          ? null
          : (trip?.expenses.get(line.expenseRef)?.body.proposal.expenseId ?? null),
      proof:
        proof === null
          ? null
          : proof.rail === 'ln'
            ? { rail: 'ln', paymentHash: proof.paymentHash }
            : { rail: 'onchain', txid: proof.txid },
    });
    this.activityItems.length = Math.min(this.activityItems.length, MAX_KEPT);
  }

  private startOp(kind: OperationView['kind'], text: string): OperationView {
    const op: OperationView = {
      id: `${this.actor}-${++this.opCounter}`,
      kind,
      status: 'running',
      text,
      startedAt: this.now().toISOString(),
      finishedAt: null,
      error: null,
    };
    this.ops.unshift(op);
    this.ops.length = Math.min(this.ops.length, MAX_KEPT);
    return op;
  }

  private endOp(op: OperationView, status: 'done' | 'failed', error: ApiError | null = null): void {
    op.status = status;
    op.finishedAt = this.now().toISOString();
    op.error = error;
  }
}
