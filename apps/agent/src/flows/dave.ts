import {
  lineKey,
  liquidityPlan,
  type LineRecord,
  type MemberState,
  type TripState,
} from '@kitty/ledger';
import {
  FINAL_LINE_STATES,
  checkBindInvoice,
  formatCents,
  type EventBody,
  type MemberId,
  type PaymentProof,
  type ProofRef,
  type Pubkey,
  type TripParams,
} from '@kitty/shared';
import { FlowError, apiErrorOf } from './errors.js';
import { MemberAgent, type MemberAgentOptions } from './member-agent.js';

// dave's agent (SPEC §5, §6.6-6.7): the coordinator never moves a traveler's funds and never
// signs for them. He sets up the trip, publishes the rate, resolves disputes, and on a default
// pays the debtor's own invoice with the operator's liquidity (the guarantee), then closes the
// member's channels and excludes them.

export interface CoverAndExcludeResult {
  /** The GUARANTEE_PAID of the requested line; null if beyond the guarantee left (SPEC §6.7). */
  covered: ProofRef | null;
  closingTxids: string[];
}

const EXCLUSION_REASON = 'Did not pay by the deadline';

/** Below this margin, dave opens more liquidity to the member (SPEC §10.5, the "soglia"). */
export const LIQUIDITY_THRESHOLD_CENTS = 1000n;

export interface CoordinatorAgentOptions extends Omit<MemberAgentOptions, 'actor'> {
  /** SPEC §10.5 threshold; default LIQUIDITY_THRESHOLD_CENTS. */
  liquidityThresholdCents?: bigint;
}

export class CoordinatorAgent extends MemberAgent {
  /** A guarantee payment done but whose GUARANTEE_PAID is not in the log yet: never pay twice. */
  private readonly guarantees = new Map<string, { line: LineRecord; proof: PaymentProof }>();
  /**
   * Liquidity opened after the first channel, per member (liquidityPlan's `extra`). Known to
   * dave's node only, never in the log; kept in memory (an agent restart forgets it and may
   * open once more: capital, never funds at risk).
   */
  private readonly extraLiquidity = new Map<Pubkey, bigint>();
  private opening: Promise<void> | null = null;
  private openRetryAt = 0;
  private readonly liquidityThresholdCents: bigint;
  private readonly openRetryMs: number;

  constructor(opts: CoordinatorAgentOptions) {
    super({ ...opts, actor: 'dave' });
    this.liquidityThresholdCents = opts.liquidityThresholdCents ?? LIQUIDITY_THRESHOLD_CENTS;
    this.openRetryMs = opts.retryMs ?? 10_000;
  }

  protected override async step(): Promise<void> {
    await super.step();
    const trip = this.trip();
    if (trip !== null) await this.publishGuarantees(trip);
    if (trip !== null) this.planLiquidity(trip);
  }

  override async idle(): Promise<void> {
    while (this.opening !== null) await this.opening;
    await super.idle();
  }

  /** What liquidityPlan says now, with the liquidity dave already added. */
  liquidityNeeds(trip: TripState | null = this.trip()) {
    return trip === null
      ? []
      : liquidityPlan(trip, this.liquidityThresholdCents, this.extraLiquidity);
  }

  /**
   * SPEC §10.5 rule 2, run at every tick: when a member's margin falls below the threshold,
   * open a new liquidity channel to them right away, before the payment that would not fit.
   * One opening at a time, in the background; a failure is retried after retryMs.
   */
  private planLiquidity(trip: TripState): void {
    if (this.opening !== null || this.now().getTime() < this.openRetryAt) return;
    const need = this.liquidityNeeds(trip).find((n) => n.openCents > 0n);
    const member = need && trip.members.get(need.memberPubkey);
    if (need === undefined || member === undefined) return;
    // A payment goes through ONE channel (no multi-path payments in RLN): the new channel must
    // also hold the largest line the member is still to receive, not only the missing margin.
    let largest = 0n;
    for (const l of trip.lines.values())
      if (l.payerPubkey === member.pubkey && l.payment === null && l.state !== 'voided')
        largest = l.cents > largest ? l.cents : largest;
    const cents = need.openCents > largest ? need.openCents : largest;
    const op = this.startOp(
      'opening_liquidity',
      `Opening ${formatCents(cents)} of liquidity to ${member.memberId} so they can be reimbursed…`,
    );
    this.opening = this.wallet
      .openLiquidity(member.nodePubkey, cents)
      .then(({ channelId }) => {
        this.extraLiquidity.set(
          member.pubkey,
          (this.extraLiquidity.get(member.pubkey) ?? 0n) + cents,
        );
        this.endOp(op, 'done');
        this.addActivity(
          `Opened ${formatCents(cents)} of liquidity to ${member.memberId} (channel ${channelId.slice(0, 8)}…): their margin was ${formatCents(need.marginCents)}.`,
          null,
          null,
        );
      })
      .catch((err: unknown) => {
        this.openRetryAt = this.now().getTime() + this.openRetryMs;
        this.endOp(op, 'failed', apiErrorOf(err));
      })
      .finally(() => {
        this.opening = null;
      });
  }

  // ---------- setting up the trip (SPEC §6.1-6.2; called by the seed, task B2) ----------

  /** TRIP_CREATED, signed by dave as the coordinator it names. */
  async createTrip(p: { name: string; assetId: string; params: TripParams }): Promise<TripState> {
    await this.sync();
    if (this.trip() !== null) throw new FlowError('NOT_ALLOWED', 'the trip already exists');
    await this.publish(null, 'TRIP_CREATED', {
      ...p,
      coordinatorPubkey: await this.authorPubkey(),
    });
    return this.requireTrip();
  }

  /** RATE_SET: the rate of the day, signed with its source (SPEC §13 #10). PUT /dave/rates. */
  async setRate(rate: EventBody<'RATE_SET'>): Promise<void> {
    const trip = await this.requireCoordinator();
    await this.publish(trip, 'RATE_SET', rate);
  }

  /** MEMBER_ADMITTED, after checking again that the member's node signed the bind invoice. */
  async admit(memberId: MemberId): Promise<MemberState> {
    const trip = await this.requireCoordinator();
    const member = this.memberById(trip, memberId);
    if (member.admitted) return member;
    const joined = this.log.events.find(
      (e) => e.signed.inner.type === 'MEMBER_JOINED' && e.signed.inner.author === member.pubkey,
    );
    const bind =
      joined?.signed.inner.type === 'MEMBER_JOINED' ? joined.signed.inner.body.bindInvoice : null;
    const decoded = bind === null ? undefined : this.log.invoices.get(bind);
    if (decoded === undefined || !checkBindInvoice(decoded, member.pubkey, member.nodePubkey))
      throw new FlowError('NOT_ALLOWED', `${memberId}'s app key is not bound to their node`);
    await this.publish(trip, 'MEMBER_ADMITTED', { memberPubkey: member.pubkey });
    return this.memberById(this.requireTrip(), memberId);
  }

  /** CHANNELS_READY: dave attests both channels with the member are open (nobody else sees them). */
  async channelsReady(
    memberId: MemberId,
    channels: { tripChannelId: string; liquidityChannelId: string },
  ): Promise<void> {
    const trip = await this.requireCoordinator();
    const member = this.memberById(trip, memberId);
    await this.publish(trip, 'CHANNELS_READY', { memberPubkey: member.pubkey, ...channels });
  }

  // ---------- during the trip (routes of task C3) ----------

  /** DISPUTE_RESOLVED (SPEC §6.6). POST /dave/disputes/:expenseId/:member. */
  async resolveDispute(
    expenseId: string,
    memberId: MemberId,
    outcome: EventBody<'DISPUTE_RESOLVED'>['outcome'],
    note: string,
  ): Promise<LineRecord> {
    const trip = await this.requireCoordinator();
    const debtor = this.memberById(trip, memberId);
    const line = this.lineOf(trip, expenseId, debtor.pubkey);
    if (line.state !== 'contested')
      throw new FlowError('NOT_ALLOWED', `the line of ${memberId} is ${line.state}, not contested`);
    await this.publish(trip, 'DISPUTE_RESOLVED', {
      expenseEventHash: line.expenseEventHash,
      debtorPubkey: debtor.pubkey,
      outcome,
      note,
    });
    return this.lineOf(this.requireTrip(), expenseId, debtor.pubkey);
  }

  /**
   * "Copri ed escludi" (SPEC §6.7). POST /dave/defaults/:expenseId/:member/cover-and-exclude.
   * 1. Pays the same invoice the debtor should have paid, with dave's liquidity, if it fits in
   *    the guarantee left (the invoice is paid in full or not at all): GUARANTEE_PAID.
   * 2. Closes both channels with the member: MEMBER_EXCLUDED with the closing txids.
   * 3. The member's other open lines are now overdue: covered too, up to G.
   */
  async coverAndExclude(expenseId: string, memberId: MemberId): Promise<CoverAndExcludeResult> {
    let trip = await this.requireCoordinator();
    const member = this.memberById(trip, memberId);
    const line = this.lineOf(trip, expenseId, member.pubkey);
    if (line.state !== 'overdue')
      throw new FlowError('NOT_ALLOWED', `the line of ${memberId} is ${line.state}, not overdue`);

    const covered = await this.cover(trip, line);

    let closingTxids = [...member.closingTxids];
    if (!member.excluded) {
      const op = this.startOp('closing_channels', `Closing both channels with ${memberId}…`);
      try {
        ({ txids: closingTxids } = await this.wallet.closeChannelsWith(member.nodePubkey));
        this.endOp(op, 'done');
      } catch (err) {
        this.endOp(op, 'failed', apiErrorOf(err));
        throw err;
      }
      await this.publish(this.requireTrip(), 'MEMBER_EXCLUDED', {
        memberPubkey: member.pubkey,
        reason: EXCLUSION_REASON,
        closingTxids,
      });
    }

    trip = this.requireTrip();
    for (const other of trip.lines.values()) {
      if (other.debtorPubkey !== member.pubkey || other.state !== 'overdue') continue;
      if (
        lineKey(other.expenseEventHash, other.debtorPubkey) ===
        lineKey(line.expenseEventHash, line.debtorPubkey)
      )
        continue;
      await this.cover(this.requireTrip(), other);
    }
    return { covered, closingTxids };
  }

  // ---------- helpers ----------

  /** One guarantee payment; null when it does not fit in the guarantee left. */
  private async cover(trip: TripState, line: LineRecord): Promise<ProofRef | null> {
    const debtor = trip.members.get(line.debtorPubkey);
    if (debtor === undefined) return null;
    const left = trip.params.guaranteeCapCents - debtor.guaranteeUsedCents;
    if (line.cents > left) {
      this.addActivity(
        `Not covered: ${formatCents(line.cents)} is above the guarantee left for ${debtor.memberId} (${formatCents(left)}).`,
        line,
        null,
      );
      return null;
    }
    const inv = this.log.invoices.get(line.bolt11);
    if (inv !== undefined && Date.parse(inv.expiresAt) <= this.now().getTime())
      throw new FlowError(
        'INVOICE_EXPIRED',
        'the invoice of this line expired: wait for the payer to reissue it',
      );

    const key = lineKey(line.expenseEventHash, line.debtorPubkey);
    const creditor = trip.members.get(line.payerPubkey)?.memberId ?? 'the payer';
    if (!this.guarantees.has(key)) {
      const op = this.startOp(
        'covering',
        `Paying ${formatCents(line.cents)} to ${creditor} with the operator's liquidity…`,
      );
      try {
        const proof = await this.wallet.pay(line.bolt11);
        if (proof.rail !== 'ln')
          throw new FlowError('PAYMENT_FAILED', 'the guarantee is paid over Lightning');
        this.guarantees.set(key, { line, proof });
        this.endOp(op, 'done');
      } catch (err) {
        this.endOp(op, 'failed', apiErrorOf(err));
        throw err;
      }
    }
    await this.publishGuarantees(trip);
    const final = this.requireTrip().lines.get(key);
    if (final?.payment?.by !== 'guarantee')
      throw new FlowError(
        'RELAY_UNREACHABLE',
        'paid, but the proof is not published yet: it will be retried',
      );
    this.addActivity(
      `Covered ${formatCents(line.cents)} to ${creditor} for ${debtor.memberId}: the operator now holds the credit.`,
      line,
      null,
    );
    return { rail: 'ln', paymentHash: final.payment.paymentHash };
  }

  /** GUARANTEE_PAID for every guarantee paid but not yet in the log; retried until it is. */
  private async publishGuarantees(trip: TripState): Promise<void> {
    for (const [key, { line, proof }] of this.guarantees) {
      const current = trip.lines.get(key);
      // Published (guaranteed) or settled another way: nothing left to publish.
      if (current === undefined || FINAL_LINE_STATES.includes(current.state)) {
        this.guarantees.delete(key);
        continue;
      }
      if (proof.rail !== 'ln') continue;
      try {
        await this.publish(trip, 'GUARANTEE_PAID', {
          expenseEventHash: line.expenseEventHash,
          debtorPubkey: line.debtorPubkey,
          creditorPubkey: line.payerPubkey,
          cents: line.cents,
          paymentHash: proof.paymentHash,
          preimage: proof.preimage,
        });
        trip = this.requireTrip();
      } catch {
        // Paid but not published: kept, published again on the next tick.
      }
    }
  }

  private async requireCoordinator(): Promise<TripState> {
    await this.sync();
    const trip = this.requireTrip();
    if ((await this.authorPubkey()) !== trip.coordinatorPubkey)
      throw new FlowError('NOT_ALLOWED', 'only the coordinator can do this');
    return trip;
  }

  private memberById(trip: TripState, memberId: MemberId): MemberState {
    const m = [...trip.members.values()].find((x) => x.memberId === memberId);
    if (m === undefined) throw new FlowError('NOT_FOUND', `${memberId} has not joined the trip`);
    return m;
  }
}
