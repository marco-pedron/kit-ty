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
} from '@kitty/shared';
import { registry as v2 } from '@kitty/ledger';
import { WalletError } from '../wallet/errors.js';
import type { Wallet } from '../wallet/types.js';
import type { RegistryTransport } from './registry-transport.js';

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
