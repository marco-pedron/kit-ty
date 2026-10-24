import {
  KIND_REGISTRY,
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
  type NostrEvent,
  type Policy,
  type RegistryKey,
} from '@kitty/shared';
import { registry as v2 } from '@kitty/ledger';
import { WalletError } from '../wallet/errors.js';
import type { Wallet } from '../wallet/types.js';
import { MemoryStore, type RegistryStore, type RegistryTransport } from './registry-transport.js';

// One member's registry v2 (KITTY_REGISTRY=v2): its NIP-06 key for the trip, the events it
// holds (each verified and decoded with its own node), and publishing. Since 23/10 there is no
// double write: with v2 the app reads and writes only this registry (RegistryAgent), and the
// legacy log is not used at all. No coordinator: the LSP node only routes payments.

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

export const toV2Policy = (p: Policy) => ({
  autoPayLimit: p.autoPayLimitCents,
  dailyCap: p.dailyCapCents,
});

export class RegistryV2 {
  private key: RegistryKey | null = null;
  private trip: Trip | null = null;
  private readonly events = new Map<string, fmt.RegistryEvent>();
  private readonly invoices = new Map<string, DecodedInvoice>();
  /** Why an event of this member was rejected by the rules, newest first (diagnostics). */
  readonly problems: string[] = [];
  private publishing: Promise<unknown> = Promise.resolve();
  private nodePubkey: string | null = null;
  /** Every verified kind-7345 event this phone has, as received (the local copy, step 4). */
  private readonly local = new Map<string, NostrEvent>();
  private readonly store: RegistryStore;
  private unsubscribe: (() => void) | null = null;
  /** Missing parents asked to the relays, with when (fetchMissing, plan §2.5). */
  private readonly asked = new Map<string, number>();

  constructor(
    private readonly o: {
      displayName: string;
      seed: Uint8Array;
      wallet: Wallet;
      transport: RegistryTransport;
      now: () => Date;
      /** The complete local copy on disk; in memory if absent (tests). */
      store?: RegistryStore;
      /** A missing parent is asked again after this (default 5 s). */
      fetchRetryMs?: number;
    },
  ) {
    this.store = o.store ?? new MemoryStore();
    for (const e of this.store.load()) if (this.valid(e)) this.local.set(e.id, e);
  }

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

  /** A CHECKPOINT of this phone's registry now: its heads, count and stateHash (plan §2.6). */
  checkpoint(): Promise<fmt.RegistryEvent & { rejected: string | null }> {
    return this.publish('CHECKPOINT', {
      frontier: ['0'.repeat(64)],
      count: 1,
      stateHash: '0'.repeat(64),
    });
  }

  /** Every event this phone holds and verified (decoded, signature checked). */
  allEvents(): fmt.RegistryEvent[] {
    return [...this.events.values()];
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

  private valid(e: NostrEvent): boolean {
    return e.kind === KIND_REGISTRY && verifyNostrEvent(e, schnorrVerifier);
  }

  /** An event from a relay or from this phone: verified, then kept in the local copy. */
  private receive(e: NostrEvent): void {
    if (this.local.has(e.id) || !this.valid(e)) return;
    this.local.set(e.id, e);
    this.store.add(e);
  }

  /** The events of `pk`: the local copy first, then the relays (offline recovery works). */
  private async eventsBy(pk: string): Promise<readonly NostrEvent[]> {
    const mine = [...this.local.values()].filter((e) => e.pubkey === pk);
    const remote = await this.o.transport.query({ authors: [pk] }).catch(() => []);
    for (const e of remote) this.receive(e);
    return [...mine, ...remote.filter((e) => !mine.some((m) => m.id === e.id))];
  }

  /**
   * After a restart or on a new phone: finds this member's trip again from the seed alone
   * (recoverTrips: the keys i = 0, 1, … until 5 in a row have no event, and the trip secret
   * each wrote to itself in TRIP_SECRET_SHARED), from the local copy and the relays. True if
   * found; then the trip's events are fetched and followed.
   */
  async recover(tripId: string): Promise<boolean> {
    if (this.trip !== null) return true;
    const found = await recoverTrips(this.o.seed, (pk) => this.eventsBy(pk));
    for (const { key, trips } of found)
      for (const t of trips) {
        const trip = this.tripOf(tripId, t.tripSecret);
        const all = [
          ...this.local.values(),
          ...(await this.o.transport.query({ tripTag: trip.tripTag }).catch(() => [])),
        ];
        const genesis = all.find((e) => {
          try {
            return fmt.readRegistryEvent(e, trip).content.type === 'TRIP_CREATED';
          } catch {
            return false; // another trip id, or not the genesis
          }
        });
        if (genesis === undefined) continue;
        for (const e of all) this.receive(e);
        this.key = key;
        this.trip = trip;
        this.follow();
        await this.sync();
        return true;
      }
    return false;
  }

  /** Subscribes to the trip on every relay: stored events first, then live ones. */
  private follow(): void {
    if (this.trip === null || this.unsubscribe !== null) return;
    this.unsubscribe = this.o.transport.subscribe({ tripTag: this.trip.tripTag }, (e) =>
      this.receive(e),
    );
  }

  /** Stops following the trip (shutdown, lose-phone). */
  close(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
  }

  /**
   * Decodes what arrived (only valid events of this trip are kept) and asks the relays for any
   * parent this phone does not have: an event waits, not applied, until all its ancestors
   * are here (plan §2.5).
   */
  async sync(): Promise<void> {
    if (this.trip === null) return;
    this.follow();
    await this.decodeArrived();
    const missing = new Set<string>();
    for (const e of this.events.values())
      for (const p of e.parents) if (!this.events.has(p)) missing.add(p);
    const now = this.o.now().getTime();
    const retry = this.o.fetchRetryMs ?? 5_000;
    const ask = [...missing].filter((id) => now - (this.asked.get(id) ?? -Infinity) >= retry);
    if (ask.length === 0) return;
    for (const id of ask) this.asked.set(id, now);
    for (const e of await this.o.transport.fetchMissing(ask).catch(() => [])) this.receive(e);
    await this.decodeArrived();
  }

  /** The events of the local copy for this trip, not decoded yet. */
  private async decodeArrived(): Promise<void> {
    const trip = this.trip;
    if (trip === null) return;
    for (const e of this.local.values()) {
      if (this.events.has(e.id) || !e.tags.some((t) => t[0] === 'T' && t[1] === trip.tripTag))
        continue;
      let r: fmt.RegistryEvent;
      try {
        r = fmt.readRegistryEvent(e, trip);
      } catch {
        continue; // another trip id, or malformed: never applied
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
    const used = await recoverTrips(this.o.seed, (pk) => this.eventsBy(pk));
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
    this.follow();
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
    this.follow();
    // The subscription delivers asynchronously: fetch the trip and the invite before joining,
    // or the join would cite nothing (an event's parents are what this phone knows).
    for (const e of await this.o.transport.query({ tripTag: this.trip.tripTag }).catch(() => []))
      this.receive(e);
    if (!this.local.has(invite.inviteRef))
      for (const e of await this.o.transport.fetchMissing([invite.inviteRef]).catch(() => []))
        this.receive(e);
    await this.sync();
    if (!this.events.has(invite.inviteRef))
      throw new Error('the invite is not on the relays yet: retry in a moment');
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
  publish<T extends fmt.EventType>(
    type: T,
    body: fmt.EventBody<T>,
  ): Promise<fmt.RegistryEvent & { rejected: string | null }> {
    // One at a time: two events of this member citing the same heads would fork its own
    // chain (C15). The loop and the routes publish for the same member.
    const run = this.publishing.then(
      () => this.publishNow(type, body),
      () => this.publishNow(type, body),
    );
    this.publishing = run.catch(() => undefined);
    return run;
  }

  private async publishNow<T extends fmt.EventType>(
    type: T,
    body: fmt.EventBody<T>,
  ): Promise<fmt.RegistryEvent & { rejected: string | null }> {
    const key = this.requireKey();
    const trip = this.requireTrip();
    await this.sync();
    const view = this.view();
    if (type !== 'TRIP_CREATED' && view === null)
      throw new Error('the trip is not on this phone yet: retry in a moment');
    const parents = type === 'TRIP_CREATED' ? [] : [...(view?.frontier ?? [])];
    // A CHECKPOINT reports exactly what it cites (plan §2.6): computed here, on the same view.
    const content = (
      type === 'CHECKPOINT' && view !== null
        ? { frontier: parents, count: view.count, stateHash: view.stateHash }
        : body
    ) as fmt.EventBody<T>;
    const unsigned = fmt.buildRegistryEvent({
      author: key.pubkey,
      createdAt: v2.unixSeconds(this.o.now().toISOString()),
      tripTag: trip.tripTag,
      parents,
      content: { v: 2, tripId: trip.tripId, type, body: content } as fmt.RegistryContent,
      tripKey: trip.tripKey,
    });
    const id = nostrEventId(unsigned);
    const signed = { ...unsigned, id, sig: schnorrSign(key.secret, id) };
    // In the local copy first: the event exists even if no relay answers now; the transport
    // delivers it to each relay when it can.
    this.receive(signed);
    await this.o.transport.publish(signed).catch(() => undefined);
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

  /** This node's decoding of an invoice of the trip; undefined if never decoded. */
  invoice(bolt11: string): DecodedInvoice | undefined {
    return this.invoices.get(bolt11);
  }

  /** Decodes (with this member's node) an invoice the app is about to attach or pay. */
  async decode(bolt11: string): Promise<DecodedInvoice> {
    const known = this.invoices.get(bolt11);
    if (known !== undefined) return known;
    const inv = await this.o.wallet.decodeInvoice(bolt11);
    this.invoices.set(bolt11, inv);
    return inv;
  }

  /** How long the invoices of a new expense must last (TripParams, 48 h by default) plus a margin. */
  invoiceExpirySec(): number | null {
    const params = this.view()?.params;
    return params === undefined ? null : params.invoiceExpirySeconds + EXPIRY_MARGIN_SECONDS;
  }

  /**
   * For the member list of the app: by node, whether I block that member and whether the
   * registry has excluded them. Null before this member is in the registry.
   */
  standing(): Map<string, { blockedByMe: boolean; excluded: boolean }> | null {
    const view = this.view();
    const me = this.key?.pubkey;
    if (view === null || me === undefined || !this.isMember(view)) return null;
    return new Map(
      [...view.members.values()].map((m) => [
        m.nodePubkey,
        { blockedByMe: m.blockedBy.includes(me), excluded: m.excluded },
      ]),
    );
  }
}
