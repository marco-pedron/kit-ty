import { deriveTrip, validateEvent, type ValidationDeps } from '@kitty/ledger';
import {
  GENESIS_HASH,
  fakeVerifier,
  storedEventHash,
  type SignedEvent,
  type StoredEvent,
} from '@kitty/shared';
import type { FakeLightningNetwork } from '../../dev-fakes/fake-wallet.js';
import type { RelayClient } from '../../relay/types.js';
import { FlowError } from '../errors.js';

// TESTS ONLY: an in-memory relay with the same rules as apps/relay (the ledger's validateEvent
// on every append, hash chain, receivedAt from the injected clock). `strict: false` accepts
// anything, to play a lying relay. Invoices are decoded from the fake Lightning network.

export class MemoryRelay implements RelayClient {
  readonly events: StoredEvent[] = [];
  private readonly backups = new Map<string, Uint8Array>();
  private readonly listeners = new Set<(e: StoredEvent) => void>();

  constructor(
    private readonly net: FakeLightningNetwork,
    private readonly now: () => Date,
    readonly opts: { strict: boolean } = { strict: true },
  ) {}

  readonly deps: ValidationDeps = {
    verify: fakeVerifier,
    decodeInvoice: (bolt11) => {
      const inv = this.net.invoices.get(bolt11);
      if (inv === undefined) throw new Error('unknown invoice');
      return inv;
    },
  };

  async append(signed: SignedEvent): Promise<StoredEvent> {
    return this.chain(signed, this.opts.strict);
  }

  /** Appends without validation, as a dishonest relay would. */
  inject(signed: SignedEvent): StoredEvent {
    return this.chain(signed, false);
  }

  private chain(signed: SignedEvent, validate: boolean): StoredEvent {
    const seq = this.events.length + 1;
    const prevHash = this.events.at(-1)?.hash ?? GENESIS_HASH;
    const at = this.now();
    const stored: StoredEvent = {
      seq,
      prevHash,
      signed,
      receivedAt: at.toISOString(),
      hash: storedEventHash({ seq, prevHash, signed }),
    };
    if (validate) {
      const verdict = validateEvent(stored, deriveTrip(this.events, at), this.deps);
      if (!verdict.ok) throw new FlowError('INVALID_EVENT', verdict.reason);
    }
    this.events.push(stored);
    for (const l of this.listeners) l(stored);
    return stored;
  }

  async list(sinceSeq = 0): Promise<StoredEvent[]> {
    return this.events.filter((e) => e.seq > sinceSeq);
  }

  subscribe(onEvent: (e: StoredEvent) => void): () => void {
    this.listeners.add(onEvent);
    return () => this.listeners.delete(onEvent);
  }

  async putBackup(pubkey: string, blob: Uint8Array): Promise<void> {
    this.backups.set(pubkey, blob);
  }

  async getBackup(pubkey: string): Promise<Uint8Array | null> {
    return this.backups.get(pubkey) ?? null;
  }
}
