import {
  FINAL_LINE_STATES as FINAL,
  DEFAULT_POLICY,
  formatCents,
  isMemberId,
  type ActivityItem,
  type ActorId,
  type ApiError,
  type AutoPayDecision,
  type EventBody,
  type EventType,
  type OperationView,
  type PaymentProof,
  type Policy,
  type Receipt,
  type SignatureVerifier,
  type SplitAssignment,
  type SplitPreview,
  type StoredEvent,
} from '@kitty/shared';
import {
  decideAutoPay,
  expenseFingerprint,
  lineKey,
  type LineRecord,
  type MemberState,
  type TripState,
} from '@kitty/ledger';
import type { RelayClient } from '../relay/types.js';
import type { Wallet, WalletBalances } from '../wallet/types.js';
import { FlowError, apiErrorOf } from './errors.js';
import { planExpense, previewOf } from './expense.js';
import { LocalLog } from './local-log.js';
import { publishEvent } from './publish.js';
import type { RegistryV2 } from './registry-v2.js';

// The agent of one member (SPEC §6, §8, §14): it holds ONLY that member's wallet, verifies
// every event itself, and acts within the member's policy. `tick()` is the loop, called every
// second by the server and by hand in tests; the clock is injected.

export interface MemberAgentOptions {
  actor: ActorId;
  wallet: Wallet;
  relay: RelayClient;
  /** fakeVerifier with KITTY_FAKES=1 (FakeWallet signs with fakeSign), B4's signatureVerifier otherwise. */
  verifier: SignatureVerifier;
  now?: () => Date;
  /** Used only to publish before TRIP_CREATED (dave); afterwards the log's tripId. */
  tripId?: string;
  /** A failed payment or publish is retried after this (default 10 s). */
  retryMs?: number;
  /** A CHECKPOINT after this many new non-checkpoint events (default 10, SPEC §9.4). */
  checkpointEvery?: number;
  /**
   * B6, SPEC §12: back the node up (lock → backup → unlock) and upload it to the relay once it
   * has been quiet this long after a change. Unset: no automatic backups (unit tests).
   */
  backupQuietMs?: number;
}

/** Event types that change a node's state (channels, invoices, payments), SPEC §12. */
const NODE_EVENTS = new Set([
  'CHANNELS_READY',
  'EXPENSE_SUBMITTED',
  'INVOICE_REISSUED',
  'PAYMENT_MADE',
  'GUARANTEE_PAID',
  'MEMBER_EXCLUDED',
]);

const OPEN = (l: LineRecord) => !FINAL.includes(l.state);
const v2Only = (memberId: string) =>
  new FlowError('NOT_ALLOWED', `blocking ${memberId} needs the registry v2 (KITTY_REGISTRY=v2)`);
const MAX_KEPT = 50;

export class MemberAgent {
  readonly actor: ActorId;
  readonly log: LocalLog;
  protected readonly wallet: Wallet;
  private readonly relay: RelayClient;
  protected readonly now: () => Date;
  protected readonly tripIdOption: string;
  private readonly retryMs: number;
  private readonly checkpointEvery: number;

  private author: string | null = null;
  /** Serialises sync and publish, so the local copy is appended in order. */
  private lock: Promise<unknown> = Promise.resolve();
  private paying: Promise<void> | null = null;
  /** Intents already published (or in flight), by `${type}:${lineKey}`, until the log shows them. */
  private readonly sent = new Set<string>();
  /** A payment that succeeded but whose PAYMENT_MADE is not in the log yet: never pay twice. */
  private readonly proofs = new Map<string, { line: LineRecord; proof: PaymentProof }>();
  private readonly retryAt = new Map<string, number>();
  private readonly decisions = new Map<string, AutoPayDecision>();
  private readonly activityItems: ActivityItem[] = [];
  private readonly ops: OperationView[] = [];
  private opCounter = 0;
  private lastCheckpointSeq = 0;
  private ticking = false;
  private readonly backupQuietMs: number | null;
  /** Events up to here were checked for node changes. */
  private backupScannedSeq = 0;
  /** When the node last changed and was not backed up since; null when the backup is current. */
  private dirtySince: number | null;
  private backingUp: Promise<void> | null = null;
  /**
   * Always null: this is the v1 agent. Since 23/10 a traveler with KITTY_REGISTRY=v2 is a
   * RegistryAgent and never touches the legacy log (no double write). Kept for the routes of
   * stream C until they read the v2 runtime.
   */
  readonly registry: RegistryV2 | null = null;

  constructor(opts: MemberAgentOptions) {
    this.actor = opts.actor;
    this.wallet = opts.wallet;
    this.relay = opts.relay;
    this.now = opts.now ?? (() => new Date());
    this.tripIdOption = opts.tripId ?? 'vietnam-2026';
    this.retryMs = opts.retryMs ?? 10_000;
    this.checkpointEvery = opts.checkpointEvery ?? 10;
    this.log = new LocalLog(opts.wallet, opts.verifier);
    this.backupQuietMs = opts.backupQuietMs ?? null;
    // A first backup after start: the relay may hold none for this node yet.
    this.dirtySince = this.now().getTime();
  }

  // ---------- reading (for the routes, task C3) ----------

  /** The trip derived from this agent's verified copy, at now. */
  trip(): TripState | null {
    return this.log.trip(this.now());
  }

  /** This agent's author key (the appPubkey with rln-rest). */
  async authorPubkey(): Promise<string> {
    this.author ??= await this.wallet.authorPubkey();
    return this.author;
  }

  /** This member as derived from the log; null before MEMBER_JOINED, and always for dave. */
  me(trip: TripState | null = this.trip()): MemberState | null {
    return this.author === null ? null : (trip?.members.get(this.author) ?? null);
  }

  policy(trip: TripState | null = this.trip()): Policy {
    return this.me(trip)?.policy ?? DEFAULT_POLICY;
  }

  /** LineView.agent: what this agent decides for one of its own lines, and why; null otherwise. */
  decisionFor(line: LineRecord, trip: TripState | null = this.trip()): AutoPayDecision | null {
    if (trip === null || line.debtorPubkey !== this.author) return null;
    if (this.proofs.has(lineKey(line.expenseEventHash, line.debtorPubkey)))
      return { pay: false, reason: `Paid ${formatCents(line.cents)}: publishing the proof.` };
    const invoice = this.log.invoices.get(line.bolt11) ?? null;
    return decideAutoPay(this.policy(trip), line, trip, this.now(), invoice);
  }

  /** The decisions of this agent, newest first (the AGENT rows of Attività). */
  /**
   * My own node's balances, for GET /state (SPEC §6.2: "50.00 in your trip channel"). null
   * while the node does not answer: the UI shows "balance not available", never a stale number.
   */
  async balances(): Promise<WalletBalances | null> {
    // during a backup (~6 s, B6) the node is not asked: "not available", never a hung /state
    const timeout = new Promise<null>((r) => setTimeout(() => r(null), 1_500));
    return Promise.race([this.wallet.balances().catch(() => null), timeout]);
  }

  activity(): readonly ActivityItem[] {
    return this.activityItems;
  }

  /** Long steps in progress or just finished, newest first (C7). */
  operations(): readonly OperationView[] {
    return this.ops;
  }

  /** Resolves when no payment is in flight (tests, shutdown). */
  async idle(): Promise<void> {
    while (this.paying !== null || this.backingUp !== null) await (this.paying ?? this.backingUp);
    await this.lock;
  }

  // ---------- the loop ----------

  /**
   * Sync with the relay, then act: LINE_SEEN, payments, reissues, checkpoints. A tick called
   * while the previous one is still running returns at once (the server ticks every second).
   */
  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      await this.step();
    } finally {
      this.ticking = false;
    }
  }

  protected async step(): Promise<void> {
    await this.sync();
    const trip = this.trip();
    if (trip === null) return;
    const author = await this.authorPubkey();
    if (trip.members.has(author)) {
      await this.markSeen(trip, author);
      await this.publishProofs(trip);
      this.maybePay(trip, author);
      await this.reissueExpired(trip, author);
    }
    await this.maybeCheckpoint(trip);
    await this.maybeBackup(trip, author);
  }

  // ---------- backups (task B6, SPEC §12) ----------

  /** A change to this node that the log does not show (dave's liquidity openings). */
  protected markNodeChanged(): void {
    this.dirtySince ??= this.now().getTime();
  }

  /** Does this event change my node? dave overrides it: every payment goes through his. */
  protected changesMyNode(e: StoredEvent, me: string, trip: TripState): boolean {
    const { type, author, body } = e.signed.inner;
    const b = body as { memberPubkey?: string; debtorPubkey?: string; creditorPubkey?: string };
    switch (type) {
      case 'CHANNELS_READY':
      case 'MEMBER_EXCLUDED':
        return b.memberPubkey === me;
      case 'EXPENSE_SUBMITTED':
      case 'INVOICE_REISSUED':
        return author === me; // my invoices
      case 'PAYMENT_MADE':
        return author === me || b.creditorPubkey === me;
      case 'GUARANTEE_PAID':
        return b.creditorPubkey === me || (b.debtorPubkey === me && trip.coordinatorPubkey === me);
      default:
        return false;
    }
  }

  /** Something else must finish first (dave: a payment may be routing through his node). */
  protected backupBlocked(): boolean {
    return false; // a traveler: only their own payment in flight, checked in maybeBackup
  }

  private async maybeBackup(trip: TripState, me: string): Promise<void> {
    if (this.backupQuietMs === null || this.backingUp !== null) return;
    const now = this.now().getTime();
    for (const e of this.log.events) {
      if (e.seq <= this.backupScannedSeq) continue;
      if (NODE_EVENTS.has(e.signed.inner.type) && this.changesMyNode(e, me, trip))
        this.dirtySince = now; // the quiet period starts again
    }
    this.backupScannedSeq = this.log.headSeq;
    if (this.dirtySince === null || now - this.dirtySince < this.backupQuietMs) return;
    if (this.paying !== null || this.backupBlocked()) return;
    if (this.ops.some((o) => o.status === 'running')) return;

    this.dirtySince = null;
    const op = this.startOp('backing_up', 'Backing up your node to the relay (encrypted)…');
    this.backingUp = (async () => {
      try {
        const { blob } = await this.wallet.backupNow();
        await this.relay.putBackup(await this.wallet.nodePubkey(), blob);
        this.endOp(op, 'done');
      } catch (err) {
        // retried after retryMs, as a payment
        this.dirtySince = this.now().getTime() - (this.backupQuietMs ?? 0) + this.retryMs;
        this.endOp(op, 'failed', apiErrorOf(err));
      }
    })().finally(() => {
      this.backingUp = null;
    });
  }

  /** Fetches and verifies the events after the local head. */
  async sync(): Promise<void> {
    await this.authorPubkey();
    await this.serial(async () => {
      for (;;) {
        const head = this.log.headSeq;
        const batch = await this.relay.list(head);
        if (batch.length === 0) return;
        await this.log.ingest(batch);
        if (this.log.headSeq === head || this.log.divergence !== null) return;
      }
    });
  }

  private async markSeen(trip: TripState, author: string): Promise<void> {
    for (const line of trip.lines.values()) {
      if (line.debtorPubkey !== author || line.state !== 'submitted') continue;
      await this.once(`LINE_SEEN:${lineKey(line.expenseEventHash, author)}`, () =>
        this.publish(trip, 'LINE_SEEN', { expenseEventHash: line.expenseEventHash }),
      );
    }
  }

  /**
   * One payment at a time per member (SPEC §10.1: value in flight is limited). Overdue lines
   * too: decideAutoPay pays one late once the debtor approved it (e.g. upheld, then approved
   * after the deadline).
   */
  private maybePay(trip: TripState, author: string): void {
    if (this.paying !== null) return;
    const now = this.now();
    for (const line of trip.lines.values()) {
      if (line.debtorPubkey !== author) continue;
      if (line.state !== 'due' && line.state !== 'overdue') continue;
      const key = lineKey(line.expenseEventHash, author);
      if (this.proofs.has(key) || (this.retryAt.get(key) ?? 0) > now.getTime()) continue;
      const decision = this.decisionFor(line, trip);
      if (decision === null) continue;
      this.noteDecision(key, decision, line);
      if (!decision.pay) continue;
      this.paying = this.pay(line, key, decision).finally(() => {
        this.paying = null;
      });
      return;
    }
  }

  private async pay(line: LineRecord, key: string, decision: AutoPayDecision): Promise<void> {
    const to = this.memberName(line.payerPubkey);
    const op = this.startOp(
      'paying',
      `Paying ${formatCents(line.cents)} to ${to} through the operator's node…`,
    );
    try {
      const proof = await this.wallet.pay(line.bolt11);
      this.proofs.set(key, { line, proof });
      this.endOp(op, 'done');
      this.addActivity(
        `Your agent paid ${formatCents(line.cents)} to ${to}: ${decision.reason.replace(/^Paying [^:]*: /, '')}`,
        line,
        proof,
      );
      const trip = this.trip();
      if (trip !== null) await this.publishProofs(trip);
    } catch (err) {
      this.retryAt.set(key, this.now().getTime() + this.retryMs);
      const error = apiErrorOf(err);
      this.endOp(op, 'failed', error);
      this.addActivity(
        `Payment of ${formatCents(line.cents)} to ${to} failed: ${error.message}. ${error.action}`,
        line,
        null,
      );
    }
  }

  /** PAYMENT_MADE for every payment done but not yet in the log; retried until it is. */
  private async publishProofs(trip: TripState): Promise<void> {
    for (const [key, { line, proof }] of this.proofs) {
      const current = trip.lines.get(key);
      if (current === undefined || !OPEN(current)) {
        this.proofs.delete(key);
        continue;
      }
      const intent = `PAYMENT_MADE:${key}`;
      if (this.sent.has(intent)) continue;
      this.sent.add(intent);
      const common = {
        expenseEventHash: line.expenseEventHash,
        creditorPubkey: line.payerPubkey,
        cents: line.cents,
      };
      try {
        await this.publish(
          trip,
          'PAYMENT_MADE',
          proof.rail === 'ln'
            ? { ...common, rail: 'ln', paymentHash: proof.paymentHash, preimage: proof.preimage }
            : { ...common, rail: 'onchain', txid: proof.txid },
        );
        this.proofs.delete(key);
      } catch {
        // Paid but not published: kept in `proofs`, published again on the next tick.
      } finally {
        this.sent.delete(intent);
      }
    }
  }

  /** As creditor: a fresh invoice when the one of an open line expired (SPEC §10.1). */
  private async reissueExpired(trip: TripState, author: string): Promise<void> {
    const now = this.now().getTime();
    for (const line of trip.lines.values()) {
      if (line.payerPubkey !== author || !OPEN(line)) continue;
      const inv = this.log.invoices.get(line.bolt11);
      if (inv === undefined || Date.parse(inv.expiresAt) > now) continue;
      const debtor = trip.members.get(line.debtorPubkey);
      if (debtor === undefined) continue;
      await this.once(`INVOICE_REISSUED:${line.bolt11}`, async () => {
        const { bolt11 } = await this.wallet.createInvoice({
          cents: line.cents,
          description: `kitty:${trip.tripId}:${line.expenseId}:${debtor.memberId}`,
          expirySec: this.invoiceExpirySec(trip),
        });
        return this.publish(trip, 'INVOICE_REISSUED', {
          expenseEventHash: line.expenseEventHash,
          debtorPubkey: line.debtorPubkey,
          bolt11,
        });
      });
    }
  }

  private async maybeCheckpoint(trip: TripState): Promise<void> {
    if (trip.head === null) return;
    const author = await this.authorPubkey();
    const isMember = trip.members.get(author)?.admitted === true;
    if (!isMember && author !== trip.coordinatorPubkey) return;
    const fresh = this.log.events.filter(
      (e) => e.seq > this.lastCheckpointSeq && e.signed.inner.type !== 'CHECKPOINT',
    ).length;
    if (fresh < this.checkpointEvery) return;
    const { seq, hash } = trip.head;
    await this.publish(trip, 'CHECKPOINT', { seq, headHash: hash });
    this.lastCheckpointSeq = seq;
  }

  // ---------- member actions (routes of task C3) ----------

  /** Shares by the ledger with the rate of the day, before sending (POST /expenses/split). */
  previewSplit(receipt: Receipt, assignments: readonly SplitAssignment[]): SplitPreview {
    const { trip, me } = this.requireMember();
    return previewOf(planExpense(trip, me, receipt, assignments), me.memberId);
  }

  /** One invoice per debtor from this member's node, then EXPENSE_SUBMITTED (SPEC §6.3). */
  async submitExpense(
    receipt: Receipt,
    assignments: readonly SplitAssignment[],
    receiptImageSha256: string,
  ): Promise<StoredEvent> {
    await this.sync();
    const { trip, me } = this.requireMember();
    const plan = planExpense(trip, me, receipt, assignments);
    const expenseId = `x${[...crypto.getRandomValues(new Uint8Array(6))].map((b) => b.toString(16).padStart(2, '0')).join('')}`;
    const op = this.startOp(
      'submitting_expense',
      `Creating ${plan.debtors.length} invoices and signing the expense…`,
    );
    try {
      const lines = [];
      for (const d of plan.debtors) {
        const { bolt11 } = await this.wallet.createInvoice({
          cents: d.cents,
          description: `kitty:${trip.tripId}:${expenseId}:${d.member.memberId}`,
          expirySec: this.invoiceExpirySec(trip),
        });
        lines.push({
          debtorPubkey: d.member.pubkey,
          cents: d.cents,
          itemIndexes: d.itemIndexes,
          bolt11,
        });
      }
      const stored = await this.publish(trip, 'EXPENSE_SUBMITTED', {
        expenseId,
        receipt,
        receiptImageSha256,
        rateEventHash: plan.rateEventHash,
        rate: plan.rate,
        totalUsdCents: plan.totalUsdCents,
        payerCents: plan.payerCents,
        payerItemIndexes: plan.payerItemIndexes,
        lines,
        fingerprint: expenseFingerprint(receipt, receiptImageSha256),
      });
      this.endOp(op, 'done');
      return stored;
    } catch (err) {
      this.endOp(op, 'failed', apiErrorOf(err));
      throw err;
    }
  }

  /** Approve or contest one of this member's lines (POST /expenses/:id/decision). */
  async decide(
    expenseId: string,
    decision: 'approve' | 'contest',
    reason?: string,
  ): Promise<LineRecord> {
    await this.sync();
    const { trip, me } = this.requireMember();
    const line = this.lineOf(trip, expenseId, me.pubkey);
    if (decision === 'contest' && reason === undefined)
      throw new FlowError('VALIDATION_ERROR', 'a contest needs a reason');
    await this.publish(trip, 'LINE_DECIDED', {
      expenseEventHash: line.expenseEventHash,
      decision,
      cents: line.cents,
      ...(reason !== undefined && { reason }),
    });
    return this.lineOf(this.requireTrip(), expenseId, me.pubkey);
  }

  /** The payer voids an expense before any payment (POST /expenses/:id/void). */
  async voidExpense(expenseId: string): Promise<void> {
    await this.sync();
    const { trip, me } = this.requireMember();
    const expense = this.expenseOf(trip, expenseId);
    if (expense.payerPubkey !== me.pubkey)
      throw new FlowError('NOT_ALLOWED', 'only the payer can void an expense');
    await this.publish(trip, 'EXPENSE_VOIDED', { expenseEventHash: expense.eventHash });
  }

  /**
   * MEMBER_JOINED (SPEC §6.1): name, policy and the bind invoice from this member's own node,
   * whose payee ties the app key to the node (SPEC §9.1). Does nothing if already joined.
   */
  async joinTrip(policy: Policy = DEFAULT_POLICY): Promise<MemberState> {
    await this.sync();
    const trip = this.requireTrip();
    if (!isMemberId(this.actor)) throw new FlowError('NOT_ALLOWED', 'only travelers join a trip');
    const existing = this.me(trip);
    if (existing !== null) return existing;
    const appPubkey = await this.authorPubkey();
    await this.publish(trip, 'MEMBER_JOINED', {
      displayName: this.actor,
      memberId: this.actor,
      appPubkey,
      nodePubkey: await this.wallet.nodePubkey(),
      bindInvoice: await this.wallet.bindInvoice(appPubkey),
      policy,
    });
    const me = this.me();
    if (me === null) throw new FlowError('INTERNAL', 'MEMBER_JOINED not in the verified log');
    return me;
  }

  /** Blocks exist only in the registry v2: with v1 there is nothing to block (routes of C). */
  blockMember(memberId: string): Promise<{ warning: string }> {
    return Promise.reject(v2Only(memberId));
  }

  unblockMember(memberId: string): Promise<void> {
    return Promise.reject(v2Only(memberId));
  }

  blockWarning(memberId: string): Promise<string> {
    return Promise.reject(v2Only(memberId));
  }

  /** Invoice expiry of the legacy trip. */
  private invoiceExpirySec(trip: TripState): number {
    return trip.params.invoiceExpirySeconds;
  }

  /** PUT /policy. */
  async updatePolicy(policy: Policy): Promise<Policy> {
    await this.sync();
    const { trip } = this.requireMember();
    await this.publish(trip, 'POLICY_UPDATED', { policy });
    return this.policy();
  }

  // ---------- helpers ----------

  /** Signs, appends and syncs; a relay rejection surfaces as the relay's error. */
  async publish<T extends EventType>(
    trip: TripState | null,
    type: T,
    body: EventBody<T>,
  ): Promise<StoredEvent> {
    const stored = await this.serial(() =>
      publishEvent(
        { wallet: this.wallet, relay: this.relay, now: this.now },
        trip?.tripId ?? this.tripIdOption,
        type,
        body,
      ),
    );
    await this.sync();
    return stored;
  }

  /** Runs an intent once: kept as sent on success, freed on failure so the next tick retries. */
  private async once(key: string, fn: () => Promise<unknown>): Promise<void> {
    if (this.sent.has(key)) return;
    this.sent.add(key);
    try {
      await fn();
    } catch (err) {
      this.sent.delete(key);
      this.addActivity(
        `Could not publish (${key.split(':')[0]}): ${apiErrorOf(err).message}`,
        null,
        null,
      );
    }
  }

  private serial<R>(fn: () => Promise<R>): Promise<R> {
    const run = this.lock.then(fn, fn);
    this.lock = run.catch(() => undefined);
    return run;
  }

  protected requireTrip(): TripState {
    const trip = this.trip();
    if (trip === null) throw new FlowError('NOT_FOUND', 'no trip yet');
    return trip;
  }

  protected requireMember(): { trip: TripState; me: MemberState } {
    const trip = this.requireTrip();
    const me = this.me(trip);
    if (me === null)
      throw new FlowError('NOT_ALLOWED', `${this.actor} is not a member of the trip`);
    return { trip, me };
  }

  protected expenseOf(trip: TripState, expenseId: string) {
    const expense = [...trip.expenses.values()].find((e) => e.body.expenseId === expenseId);
    if (expense === undefined) throw new FlowError('NOT_FOUND', `no expense ${expenseId}`);
    return expense;
  }

  protected lineOf(trip: TripState, expenseId: string, debtor: string): LineRecord {
    const line = trip.lines.get(lineKey(this.expenseOf(trip, expenseId).eventHash, debtor));
    if (line === undefined) throw new FlowError('NOT_FOUND', `you owe nothing on ${expenseId}`);
    return line;
  }

  protected memberName(pubkey: string): string {
    return this.trip()?.members.get(pubkey)?.memberId ?? 'the payer';
  }

  private noteDecision(key: string, decision: AutoPayDecision, line: LineRecord): void {
    if (this.decisions.get(key)?.reason === decision.reason) return;
    this.decisions.set(key, decision);
    if (!decision.pay) this.addActivity(decision.reason, line, null);
  }

  protected addActivity(text: string, line: LineRecord | null, proof: PaymentProof | null): void {
    this.activityItems.unshift({
      at: this.now().toISOString(),
      kind: 'AGENT',
      text,
      expenseId: line?.expenseId ?? null,
      proof:
        proof === null
          ? null
          : proof.rail === 'ln'
            ? { rail: 'ln', paymentHash: proof.paymentHash }
            : { rail: 'onchain', txid: proof.txid },
    });
    this.activityItems.length = Math.min(this.activityItems.length, MAX_KEPT);
  }

  protected startOp(kind: OperationView['kind'], text: string): OperationView {
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

  protected endOp(
    op: OperationView,
    status: 'done' | 'failed',
    error: ApiError | null = null,
  ): void {
    op.status = status;
    op.finishedAt = this.now().toISOString();
    op.error = error;
  }
}
