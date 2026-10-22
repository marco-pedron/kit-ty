import {
  KIND_REGISTRY,
  nostrEventId,
  registry,
  registryTags,
  schnorrPublicKeyHex,
  schnorrSign,
  schnorrVerifier,
  sha256Hex,
  type DecodedInvoice,
} from '@kitty/shared';
import { hexToBytes } from '../hex.js';
import { expenseFingerprint, expenseShares } from '../shares.js';
import type { RegistryDeps } from '../registry/validate.js';

// A registry v2 trip built by hand for the step-2 tests: real NIP-01 ids, real Schnorr keys
// (for the signatures at the table), a fake BOLT11 decoder. No crypto of the Nostr layer:
// deriveRegistry gets events already decoded and checked.

export const TRIP_TAG = 'e'.repeat(64);
export const TRIP_ID = 'vietnam-2026';
export const ASSET = 'rgb:dusd-test';
export const T0 = 1_760_000_000;
export const PARAMS: registry.TripParams = {
  assetId: ASSET,
  assetDecimals: 2,
  displayDecimals: 2,
  silentAssentSeconds: 20,
  invoiceExpirySeconds: 172_800,
  rateMaxAgeSeconds: 86_400,
  oracles: [],
};

export const SECRETS = {
  alice: '01'.padStart(64, '0'),
  bob: '02'.padStart(64, '0'),
  charlie: '03'.padStart(64, '0'),
} as const;
export type Name = keyof typeof SECRETS;
export const PK = Object.fromEntries(
  Object.entries(SECRETS).map(([n, s]) => [n, schnorrPublicKeyHex(s)]),
) as Record<Name, string>;
export const NODE: Record<Name, string> = {
  alice: `02${'a1'.repeat(32)}`,
  bob: `02${'b2'.repeat(32)}`,
  charlie: `02${'c3'.repeat(32)}`,
};
export const POLICY = { autoPayLimit: 2000n, dailyCap: 6000n };

type Content = registry.RegistryContent;
type Ev = registry.RegistryEvent;

export class TestTrip {
  readonly events: Ev[] = [];
  private readonly invoices = new Map<string, DecodedInvoice>();
  private readonly preimages = new Map<string, string>();
  private n = 0;

  readonly deps: RegistryDeps = {
    verify: schnorrVerifier,
    tripTag: TRIP_TAG,
    decodeInvoice: (bolt11) => {
      const inv = this.invoices.get(bolt11);
      if (inv === undefined) throw new Error(`unknown invoice ${bolt11}`);
      return inv;
    },
  };

  readonly genesis: Ev;

  constructor(creator: Name = 'alice') {
    this.genesis = this.raw(creator, [], {
      v: 2,
      tripId: TRIP_ID,
      type: 'TRIP_CREATED',
      body: { name: 'Vietnam 2026', params: PARAMS, relays: ['wss://relay.test'] },
    });
  }

  /** Adds an event citing `parents` (default: every head, i.e. the author saw everything). */
  add<T extends registry.EventType>(
    author: Name,
    type: T,
    body: registry.EventBody<T>,
    opts: { parents?: readonly Ev[]; createdAt?: number } = {},
  ): Ev {
    const parents = (opts.parents ?? this.heads()).map((e) => e.id);
    return this.raw(
      author,
      parents,
      { v: 2, tripId: TRIP_ID, type, body } as Content,
      opts.createdAt,
    );
  }

  private raw(author: Name, parents: string[], content: Content, createdAt?: number): Ev {
    this.n += 1;
    const created_at = createdAt ?? T0 + this.n;
    const id = nostrEventId({
      pubkey: PK[author],
      created_at,
      kind: KIND_REGISTRY,
      tags: registryTags(TRIP_TAG, parents),
      content: `${content.type}#${this.n}`,
    });
    const e: Ev = {
      id,
      author: PK[author],
      createdAt: created_at,
      parents: [...parents].sort(),
      content,
    };
    this.events.push(e);
    return e;
  }

  heads(): Ev[] {
    const cited = new Set(this.events.flatMap((e) => e.parents));
    return this.events.filter((e) => !cited.has(e.id));
  }

  invoice(payer: Name, amount: bigint, opts: { expiresAt?: number; node?: string } = {}): string {
    this.n += 1;
    const bolt11 = `lnbcrt${this.n}x${payer}`;
    const preimage = this.n.toString(16).padStart(64, '0');
    this.preimages.set(bolt11, preimage);
    this.invoices.set(bolt11, {
      bolt11,
      payeePubkey: opts.node ?? NODE[payer],
      paymentHash: sha256Hex(hexToBytes(preimage)),
      assetId: ASSET,
      cents: amount,
      amtMsat: 3_000_000n,
      description: '',
      expiresAt: new Date((opts.expiresAt ?? T0 + 10 * 86_400) * 1000).toISOString(),
    });
    return bolt11;
  }

  paymentHashOf(bolt11: string): string {
    return this.deps.decodeInvoice(bolt11).paymentHash;
  }

  join(who: Name, invite: Ev | null, opts: { parents?: readonly Ev[] } = {}): Ev {
    this.n += 1;
    const bindInvoice = `lnbcrt${this.n}bind${who}`;
    this.invoices.set(bindInvoice, {
      bolt11: bindInvoice,
      payeePubkey: NODE[who],
      paymentHash: '00'.repeat(32),
      assetId: null,
      cents: null,
      amtMsat: null,
      description: `kitty-bind:v2:${TRIP_TAG}:${PK[who]}`,
      expiresAt: new Date((T0 + 86_400) * 1000).toISOString(),
    });
    return this.add(
      who,
      'MEMBER_JOINED',
      {
        inviteRef: invite?.id ?? null,
        displayName: who,
        nodePubkey: NODE[who],
        bindInvoice,
        policy: POLICY,
      },
      opts,
    );
  }

  invite(by: Name, opts: { parents?: readonly Ev[]; for?: Name } = {}): Ev {
    this.n += 1;
    return this.add(
      by,
      'MEMBER_INVITED',
      {
        inviteId: this.n.toString(16).padStart(32, '0'),
        ...(opts.for !== undefined && { inviteePubkey: PK[opts.for] }),
        expiresAt: T0 + 86_400,
      },
      opts,
    );
  }

  /** alice creates the trip and invites the others (by default bob and charlie). Dave is not
   * in the registry: he only routes payments (LSP). */
  static withMembers(others: Name[] = ['bob', 'charlie']): TestTrip {
    const t = new TestTrip();
    t.join('alice', null);
    for (const who of others) t.join(who, t.invite('alice'));
    return t;
  }

  /**
   * An expense in USD: one item of `unit × parties` cents shared by payer and debtors, so each
   * share is `unit`. Shares recomputed by the ledger, as the app does.
   */
  expenseBody(
    payer: Name,
    debtors: Name[],
    opts: { unit?: bigint; signed?: Name[]; expenseId?: string; merchant?: string } = {},
  ): registry.EventBody<'EXPENSE_SUBMITTED'> {
    this.n += 1;
    const unit = opts.unit ?? 300n;
    const total = unit * BigInt(debtors.length + 1);
    const receipt = {
      merchant: opts.merchant ?? 'Pho 24',
      date: '2026-10-20',
      currency: 'USD' as const,
      items: [{ label: 'Dinner', quantity: 1, unitPrice: total, total }],
      total,
      warnings: [],
    };
    const shares = expenseShares({
      receipt,
      rate: '1',
      payer: PK[payer],
      payerItemIndexes: [0],
      debtors: debtors.map((d) => ({ id: PK[d], itemIndexes: [0] })),
    });
    const proposal: registry.Proposal = {
      tripId: TRIP_ID,
      expenseId: opts.expenseId ?? `exp-${this.n}`,
      payer: PK[payer],
      receipt,
      rate: { pair: 'USD/USD', value: '1', asOf: '2026-10-20T08:00:00.000Z', source: 'test' },
      assetId: ASSET,
      assetDecimals: 2,
      total: shares.totalUsdCents,
      payerAmount: shares.payerCents,
      payerItemIndexes: [0],
      lines: shares.debtors.map((d) => ({ debtor: d.id, amount: d.cents, itemIndexes: [0] })),
    };
    const digest = registry.proposalDigest(proposal);
    const receiptImageSha256 = this.n.toString(16).padStart(64, '0');
    return {
      proposal,
      tableSignatures: (opts.signed ?? []).map((s) => ({
        signer: PK[s],
        sig: schnorrSign(SECRETS[s], digest),
      })),
      invoices: shares.debtors.map((d) => ({
        debtor: d.id,
        bolt11: this.invoice(payer, d.cents),
      })),
      receiptImageSha256,
      fingerprint: expenseFingerprint(receipt, receiptImageSha256),
    };
  }

  expense(
    payer: Name,
    debtors: Name[],
    opts: Parameters<TestTrip['expenseBody']>[2] & { parents?: readonly Ev[] } = {},
  ): Ev {
    return this.add(payer, 'EXPENSE_SUBMITTED', this.expenseBody(payer, debtors, opts), opts);
  }

  /** A valid Lightning payment of the line of `debtor` on `expense`, on its first invoice. */
  pay(
    debtor: Name,
    expense: Ev,
    opts: { parents?: readonly Ev[]; createdAt?: number; bolt11?: string } = {},
  ): Ev {
    const body = (expense.content as registry.RegistryContentOf<'EXPENSE_SUBMITTED'>).body;
    const line = body.proposal.lines.find((l) => l.debtor === PK[debtor]);
    const bolt11 = opts.bolt11 ?? body.invoices.find((i) => i.debtor === PK[debtor])?.bolt11 ?? '';
    const preimage = this.preimages.get(bolt11) ?? '00'.repeat(32);
    const { paymentHash } = this.deps.decodeInvoice(bolt11);
    return this.add(
      debtor,
      'PAYMENT_MADE',
      {
        expenseRef: expense.id,
        creditor: body.proposal.payer,
        amount: line?.amount ?? 0n,
        rail: 'ln',
        paymentHash,
        preimage,
      },
      opts,
    );
  }
}

/** Fisher-Yates with a seeded generator: an arrival order that is not the creation order. */
export function shuffled<T>(items: readonly T[], seed: number): T[] {
  const out = [...items];
  let s = seed >>> 0 || 1;
  for (let i = out.length - 1; i > 0; i--) {
    s = (s * 1_103_515_245 + 12_345) >>> 0;
    const j = s % (i + 1);
    [out[i], out[j]] = [out[j] as T, out[i] as T];
  }
  return out;
}
