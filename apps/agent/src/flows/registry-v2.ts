import {
  bindDescriptionV2,
  newTripSecret,
  nextRegistryIndex,
  nostrEventId,
  recoverTrips,
  registry as fmt,
  registryKey,
  schnorrSign,
  schnorrVerifier,
  sealTripSecret,
  tripContentKey,
  tripTagOf,
  verifyNostrEvent,
  type DecodedInvoice,
  type Policy,
  type RegistryKey,
  type StoredEvent,
} from '@kitty/shared';
import { registry as v2, type LineRecord, type TripState } from '@kitty/ledger';
import { WalletError } from '../wallet/errors.js';
import type { Wallet } from '../wallet/types.js';
import type { RegistryTransport } from './registry-transport.js';

// One member's registry v2 (KITTY_REGISTRY=v2, step 3), next to the legacy log that still runs
// the demo: the "double write" agreed on 22/10. Every event this member writes in the legacy
// log is mirrored here, signed with the member's NIP-06 key for this trip; the legacy log keeps
// the coordinator's actions (dispute, guarantee, exclusion), which v2 does not have. The v2
// rules gate the app: expenseRefusal before an expense, invoiceRefusal and manual_only before
// every payment, and the blocks, which exist only here.

/** What the inviter hands over with the QR (simulated in-process in the demo). */
export interface InvitePackage {
  tripId: string;
  tripSecret: string;
  inviteRef: string;
}

interface Trip {
  tripId: string;
  tripSecret: string;
  tripTag: string;
  tripKey: Uint8Array;
}

/** Invoices are made this much longer than invoiceExpirySeconds: they are created before the event. */
const EXPIRY_MARGIN_SECONDS = 3_600;
const INVITE_SECONDS = 86_400;

const randomHex = (bytes: number) =>
  [...crypto.getRandomValues(new Uint8Array(bytes))]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');

/** RATE_SET.asOf is a day ("2026-10-17"); the registry wants an instant. */
const isoDateTime = (d: string) => (/^\d{4}-\d{2}-\d{2}$/u.test(d) ? `${d}T00:00:00.000Z` : d);

const toV2Policy = (p: Policy) => ({
  autoPayLimit: p.autoPayLimitCents,
  dailyCap: p.dailyCapCents,
});

export class RegistryV2 {
  private key: RegistryKey | null = null;
  private trip: Trip | null = null;
  private readonly events = new Map<string, fmt.RegistryEvent>();
  private readonly invoices = new Map<string, DecodedInvoice>();
  /** Legacy events of this member already mirrored (or that cannot be), by hash. */
  private readonly mirrored = new Set<string>();
  /** Why a mirrored event was rejected by the v2 rules, newest first (diagnostics). */
  readonly problems: string[] = [];
  private nodePubkey: string | null = null;

  constructor(
    private readonly o: {
      displayName: string;
      seed: Uint8Array;
      wallet: Wallet;
      transport: RegistryTransport;
      now: () => Date;
    },
  ) {}

  get pubkey(): string | null {
    return this.key?.pubkey ?? null;
  }

  get tripTag(): string | null {
    return this.trip?.tripTag ?? null;
  }

  // ---------- reading ----------

  view(now: Date = this.o.now()): v2.RegistryTrip | null {
    if (this.trip === null) return null;
    return v2.deriveRegistry(
      [...this.events.values()],
      this.deps(),
      v2.unixSeconds(now.toISOString()),
    );
  }

  /** Joined, in the trip, as derived from the registry. */
  isMember(view = this.view()): boolean {
    return this.key !== null && view?.members.get(this.key.pubkey) !== undefined;
  }

  memberByNode(view: v2.RegistryTrip, nodePubkey: string): v2.RegistryMember | undefined {
    return [...view.members.values()].find((m) => m.nodePubkey === nodePubkey);
  }

  private deps(): v2.RegistryDeps {
    return {
      verify: schnorrVerifier,
      tripTag: this.trip?.tripTag ?? '',
      decodeInvoice: (bolt11) => {
        const inv = this.invoices.get(bolt11);
        if (inv === undefined) throw new Error('not decodable by this node');
        return inv;
      },
    };
  }

  // ---------- recovery and sync ----------

  /**
   * After a restart: finds this member's trip again from the seed alone (recoverTrips: the
   * keys i = 0, 1, … and the trip secret each wrote to itself). True if found.
   */
  async recover(tripId: string): Promise<boolean> {
    if (this.trip !== null) return true;
    const found = await recoverTrips(this.o.seed, (pk) =>
      this.o.transport.query({ authors: [pk] }),
    );
    for (const { key, trips } of found)
      for (const t of trips) {
        const trip = this.tripOf(tripId, t.tripSecret);
        const genesis = (await this.o.transport.query({ tripTag: trip.tripTag })).find((e) => {
          try {
            return fmt.readRegistryEvent(e, trip).content.type === 'TRIP_CREATED';
          } catch {
            return false; // another trip id, or not the genesis
          }
        });
        if (genesis === undefined) continue;
        this.key = key;
        this.trip = trip;
        await this.sync();
        return true;
      }
    return false;
  }

  /** Fetches the events of the trip; only valid, decodable ones are kept. */
  async sync(): Promise<void> {
    if (this.trip === null) return;
    for (const e of await this.o.transport.query({ tripTag: this.trip.tripTag })) {
      if (this.events.has(e.id) || !verifyNostrEvent(e, schnorrVerifier)) continue;
      let r: fmt.RegistryEvent;
      try {
        r = fmt.readRegistryEvent(e, this.trip);
      } catch {
        continue; // another trip, or malformed: never applied
      }
      await this.decodeAll(r);
      this.events.set(r.id, r);
    }
  }

  private async decodeAll(e: fmt.RegistryEvent): Promise<void> {
    const c = e.content;
    const all =
      c.type === 'MEMBER_JOINED'
        ? [c.body.bindInvoice]
        : c.type === 'EXPENSE_SUBMITTED'
          ? c.body.invoices.map((i) => i.bolt11)
          : c.type === 'INVOICE_REISSUED'
            ? [c.body.bolt11]
            : [];
    for (const bolt11 of all) {
      if (this.invoices.has(bolt11)) continue;
      try {
        this.invoices.set(bolt11, await this.o.wallet.decodeInvoice(bolt11));
      } catch (err) {
        if (err instanceof WalletError && err.code === 'NODE_UNREACHABLE') throw err;
        // Not decodable: the rules reject the event with that reason.
      }
    }
  }

  private tripOf(tripId: string, tripSecret: string): Trip {
    return {
      tripId,
      tripSecret,
      tripTag: tripTagOf(tripSecret),
      tripKey: tripContentKey(tripSecret),
    };
  }

  /** A fresh NIP-06 account for a new trip: one past the highest this seed already used. */
  private async newKey(): Promise<RegistryKey> {
    const used = await recoverTrips(this.o.seed, (pk) => this.o.transport.query({ authors: [pk] }));
    return registryKey(this.o.seed, nextRegistryIndex(used.map((u) => u.key.index)));
  }

  // ---------- trip, invites, joins ----------

  /** TRIP_CREATED, then the creator's own MEMBER_JOINED (no invite) and TRIP_SECRET_SHARED. */
  async createTrip(p: {
    tripId: string;
    name: string;
    params: fmt.TripParams;
    relays: string[];
    policy: Policy;
  }): Promise<void> {
    if (this.trip !== null) return;
    this.key = await this.newKey();
    this.trip = this.tripOf(p.tripId, newTripSecret());
    await this.publish('TRIP_CREATED', { name: p.name, params: p.params, relays: p.relays });
    await this.joinAs(null, p.policy);
  }

  /** MEMBER_INVITED, and what the QR carries to the invitee. */
  async invite(): Promise<InvitePackage> {
    if (this.trip === null) throw new Error('no registry v2 trip to invite to');
    const now = v2.unixSeconds(this.o.now().toISOString());
    const e = await this.publish('MEMBER_INVITED', {
      inviteId: randomHex(16),
      expiresAt: now + INVITE_SECONDS,
    });
    return { tripId: this.trip.tripId, tripSecret: this.trip.tripSecret, inviteRef: e.id };
  }

  /** With an invite: a key for this trip, MEMBER_JOINED with the bind invoice, the secret to itself. */
  async join(invite: InvitePackage, policy: Policy): Promise<void> {
    if (this.trip !== null) return;
    this.key = await this.newKey();
    this.trip = this.tripOf(invite.tripId, invite.tripSecret);
    await this.sync();
    await this.joinAs(invite.inviteRef, policy);
  }

  private async joinAs(inviteRef: string | null, policy: Policy): Promise<void> {
    const key = this.requireKey();
    const trip = this.requireTrip();
    this.nodePubkey ??= await this.o.wallet.nodePubkey();
    // kitty-bind:v2 (step 3): an invoice of this member's node, never paid, whose payee ties
    // the node to the registry key of this trip.
    const { bolt11 } = await this.o.wallet.createInvoice({
      cents: 1n,
      description: bindDescriptionV2(trip.tripTag, key.pubkey),
      expirySec: 3_600,
    });
    await this.publish('MEMBER_JOINED', {
      inviteRef,
      displayName: this.o.displayName,
      nodePubkey: this.nodePubkey,
      bindInvoice: bolt11,
      policy: toV2Policy(policy),
    });
    await this.publish('TRIP_SECRET_SHARED', {
      recipients: [
        { pubkey: key.pubkey, ciphertext: sealTripSecret(trip.tripSecret, key.secret, key.pubkey) },
      ],
    });
  }

  // ---------- writing ----------

  /** Signs with this trip's key, citing every head known, and publishes. Returns the event and, if
   * the rules reject it, why. */
  async publish<T extends fmt.EventType>(
    type: T,
    body: fmt.EventBody<T>,
  ): Promise<fmt.RegistryEvent & { rejected: string | null }> {
    const key = this.requireKey();
    const trip = this.requireTrip();
    await this.sync();
    const parents = type === 'TRIP_CREATED' ? [] : [...(this.view()?.frontier ?? [])];
    const unsigned = fmt.buildRegistryEvent({
      author: key.pubkey,
      createdAt: v2.unixSeconds(this.o.now().toISOString()),
      tripTag: trip.tripTag,
      parents,
      content: { v: 2, tripId: trip.tripId, type, body } as fmt.RegistryContent,
      tripKey: trip.tripKey,
    });
    const id = nostrEventId(unsigned);
    const signed = { ...unsigned, id, sig: schnorrSign(key.secret, id) };
    await this.o.transport.publish(signed);
    await this.sync();
    const rejected = this.view()?.rejected.find((r) => r.id === id)?.reason ?? null;
    if (rejected !== null) this.problems.unshift(`${type} rejected: ${rejected}`);
    return { ...(this.events.get(id) as fmt.RegistryEvent), rejected };
  }

  private requireKey(): RegistryKey {
    if (this.key === null) throw new Error('no registry v2 key yet');
    return this.key;
  }

  private requireTrip(): Trip {
    if (this.trip === null) throw new Error('no registry v2 trip yet');
    return this.trip;
  }

  // ---------- the rules that gate the app ----------

  /** How long the invoices of a new expense must last (TripParams, 48 h by default) plus a margin. */
  invoiceExpirySec(): number | null {
    const params = this.view()?.params;
    return params === undefined ? null : params.invoiceExpirySeconds + EXPIRY_MARGIN_SECONDS;
  }

  /** expenseRefusal on the registry, with the legacy members mapped through their nodes. */
  expenseRefusal(payerNode: string, debtorNodes: readonly string[]): string | null {
    const view = this.view();
    if (view === null || !this.isMember(view))
      return 'the registry v2 of this trip is not ready yet';
    const debtors: string[] = [];
    for (const node of debtorNodes) {
      const m = this.memberByNode(view, node);
      if (m === undefined) return 'a debtor is not in the registry v2';
      debtors.push(m.pubkey);
    }
    const payer = this.memberByNode(view, payerNode);
    if (payer === undefined) return 'you are not in the registry v2';
    return v2.expenseRefusal(view.fold, payer.pubkey, debtors);
  }

  /** The registry line of a legacy line, if the expense is already mirrored. */
  lineOf(view: v2.RegistryTrip, legacy: TripState, line: LineRecord): v2.RegistryLine | null {
    const payerNode = legacy.members.get(line.payerPubkey)?.nodePubkey;
    const debtorNode = legacy.members.get(line.debtorPubkey)?.nodePubkey;
    const payer = payerNode && this.memberByNode(view, payerNode);
    const debtor = debtorNode && this.memberByNode(view, debtorNode);
    if (!payer || !debtor) return null;
    const ref = [...view.expenses].find(
      ([, x]) => x.payer === payer.pubkey && x.body.proposal.expenseId === line.expenseId,
    )?.[0];
    return ref === undefined ? null : (view.lines.get(v2.lineKey(ref, debtor.pubkey)) ?? null);
  }

  /**
   * Before every payment (D2): null if the registry lets this member pay the line now, else
   * why not. The line must be in the registry, not manual_only, and its invoice must pass
   * invoiceRefusal (issued for the line, to the node the creditor bound, amount, asset, expiry).
   */
  paymentRefusal(
    legacy: TripState,
    line: LineRecord,
    invoice: DecodedInvoice | null,
  ): string | null {
    const view = this.view();
    if (view === null) return 'the registry v2 of this trip is not ready yet';
    const l = this.lineOf(view, legacy, line);
    if (l === null) return 'the expense is not in the registry v2 yet';
    if (l.state === 'manual_only')
      return l.manualOnly === 'blocked'
        ? 'you and the payer are blocked: pay it by hand'
        : 'an exclusion makes this line payable by hand only';
    return v2.invoiceRefusal(view, l, invoice, v2.unixSeconds(this.o.now().toISOString()));
  }

  /** MEMBER_BLOCKED on the member with this node; returns the warning the app shows (exclusion). */
  async block(targetNode: string): Promise<{ warning: string }> {
    const { me, target, view } = this.pair(targetNode);
    const warning = v2.blockWarning(view.fold, me, target);
    const e = await this.publish('MEMBER_BLOCKED', { target });
    if (e.rejected !== null) throw new Error(e.rejected);
    return { warning };
  }

  /** MEMBER_UNBLOCKED (C7: only who blocked; removes every block it knows). */
  async unblock(targetNode: string): Promise<void> {
    const { target } = this.pair(targetNode);
    const e = await this.publish('MEMBER_UNBLOCKED', { target });
    if (e.rejected !== null) throw new Error(e.rejected);
  }

  /** The warning shown before blocking, without blocking. */
  blockWarning(targetNode: string): string {
    const { me, target, view } = this.pair(targetNode);
    return v2.blockWarning(view.fold, me, target);
  }

  private pair(targetNode: string): { me: string; target: string; view: v2.RegistryTrip } {
    const view = this.view();
    const me = this.key?.pubkey;
    if (view === null || me === undefined || !this.isMember(view))
      throw new Error('the registry v2 of this trip is not ready yet');
    const target = this.memberByNode(view, targetNode);
    if (target === undefined) throw new Error('that member is not in the registry v2');
    return { me, target: target.pubkey, view };
  }

  // ---------- the double write ----------

  /**
   * Mirrors this member's own legacy events, in their order, into the registry. Stops at the
   * first one whose expense is not in the registry yet (next tick); a mirror the rules reject is
   * recorded in `problems` and not retried. The coordinator's events have no v2 equivalent.
   */
  async mirror(events: readonly StoredEvent[], legacy: TripState, me: string): Promise<void> {
    if (!this.isMember()) return;
    for (const e of events) {
      if (e.signed.inner.author !== me || this.mirrored.has(e.hash)) continue;
      try {
        if (!(await this.mirrorOne(e, legacy))) return;
      } catch (err) {
        if (err instanceof WalletError && err.code === 'NODE_UNREACHABLE') throw err;
        this.problems.unshift(`${e.signed.inner.type} not mirrored: ${String(err)}`);
      }
      this.mirrored.add(e.hash);
    }
  }

  private async mirrorOne(e: StoredEvent, legacy: TripState): Promise<boolean> {
    const inner = e.signed.inner;
    const view = this.view();
    if (view === null) return false;
    const node = (pk: string) => legacy.members.get(pk)?.nodePubkey ?? '';
    const v2Key = (pk: string) => this.memberByNode(view, node(pk))?.pubkey ?? null;
    /** The registry expense of a legacy expense event, if already there. */
    const expenseRef = (hash: string): string | null => {
      const x = legacy.expenses.get(hash);
      const payer = x && v2Key(x.payerPubkey);
      if (!x || !payer) return null;
      return (
        [...view.expenses].find(
          ([, y]) => y.payer === payer && y.body.proposal.expenseId === x.body.expenseId,
        )?.[0] ?? null
      );
    };
    switch (inner.type) {
      case 'EXPENSE_SUBMITTED': {
        const b = inner.body;
        const debtors = b.lines.map((l) => v2Key(l.debtorPubkey));
        const payer = v2Key(inner.author);
        if (payer === null || debtors.some((d) => d === null)) return false;
        await this.publish('EXPENSE_SUBMITTED', {
          proposal: {
            tripId: this.requireTrip().tripId,
            expenseId: b.expenseId,
            payer,
            receipt: b.receipt,
            rate: {
              pair: `USD/${b.receipt.currency}`,
              value: b.rate,
              asOf: isoDateTime(legacy.rate?.body.asOf ?? inner.createdAt),
              source: legacy.rate?.body.source ?? 'legacy RATE_SET',
            },
            assetId: view.params.assetId,
            assetDecimals: view.params.assetDecimals,
            total: b.totalUsdCents,
            payerAmount: b.payerCents,
            payerItemIndexes: b.payerItemIndexes,
            lines: b.lines.map((l, i) => ({
              debtor: debtors[i] as string,
              amount: l.cents,
              itemIndexes: l.itemIndexes,
            })),
          },
          tableSignatures: [],
          invoices: b.lines.map((l, i) => ({ debtor: debtors[i] as string, bolt11: l.bolt11 })),
          receiptImageSha256: b.receiptImageSha256,
          fingerprint: b.fingerprint,
        });
        return true;
      }
      case 'LINE_SEEN':
      case 'EXPENSE_VOIDED': {
        const ref = expenseRef(inner.body.expenseEventHash);
        if (ref === null) return false;
        await this.publish(inner.type, { expenseRef: ref });
        return true;
      }
      case 'LINE_DECIDED': {
        const ref = expenseRef(inner.body.expenseEventHash);
        if (ref === null) return false;
        const b = inner.body;
        await this.publish('LINE_DECIDED', {
          expenseRef: ref,
          decision: b.decision,
          amount: b.cents,
          ...(b.reason !== undefined && { reason: b.reason }),
        });
        return true;
      }
      case 'PAYMENT_MADE': {
        const b = inner.body;
        const ref = expenseRef(b.expenseEventHash);
        const creditor = v2Key(b.creditorPubkey);
        if (ref === null || creditor === null) return false;
        const common = { expenseRef: ref, creditor, amount: b.cents };
        await this.publish(
          'PAYMENT_MADE',
          b.rail === 'ln'
            ? { ...common, rail: 'ln', paymentHash: b.paymentHash, preimage: b.preimage }
            : { ...common, rail: 'onchain', txid: b.txid },
        );
        return true;
      }
      case 'INVOICE_REISSUED': {
        const b = inner.body;
        const ref = expenseRef(b.expenseEventHash);
        const debtor = v2Key(b.debtorPubkey);
        if (ref === null || debtor === null) return false;
        await this.publish('INVOICE_REISSUED', { expenseRef: ref, debtor, bolt11: b.bolt11 });
        return true;
      }
      case 'POLICY_UPDATED':
        await this.publish('POLICY_UPDATED', { policy: toV2Policy(inner.body.policy) });
        return true;
      case 'CHECKPOINT': {
        await this.publish('CHECKPOINT', {
          frontier: [...view.frontier],
          count: view.count,
          stateHash: view.stateHash,
        });
        return true;
      }
      default:
        return true; // MEMBER_JOINED is written by join(); the rest are the coordinator's
    }
  }
}
