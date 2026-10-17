import { deriveTrip, validateEvent, type TripState } from '@kitty/ledger';
import {
  signingMessage,
  type DecodedInvoice,
  type LedgerHealth,
  type SignatureVerifier,
  type StoredEvent,
} from '@kitty/shared';
import { WalletError } from '../wallet/errors.js';
import type { Wallet } from '../wallet/types.js';

// The agent's own verified copy of the log (SPEC §9.3-9.5): nothing from the relay is
// trusted. Each event is validated with the ledger's validateEvent against the trip derived
// from the events before it, with invoices decoded by the member's own node (cached, since
// validateEvent needs a synchronous decoder). The first event the agent rejects freezes the
// copy: the relay accepted something this agent does not, so the histories have diverged.

/** The bolt11 strings an event carries, decoded before validating it. */
function invoicesOf(e: StoredEvent): string[] {
  const inner = e.signed.inner;
  switch (inner.type) {
    case 'MEMBER_JOINED':
      return inner.body.bindInvoice === null ? [] : [inner.body.bindInvoice];
    case 'EXPENSE_SUBMITTED':
      return inner.body.lines.map((l) => l.bolt11);
    case 'INVOICE_REISSUED':
      return [inner.body.bolt11];
    default:
      return [];
  }
}

export interface Divergence {
  seq: number;
  hash: string;
  reason: string;
}

export class LocalLog {
  readonly events: StoredEvent[] = [];
  /** Decoded by this member's node: also the invoice decideAutoPay checks before paying. */
  readonly invoices = new Map<string, DecodedInvoice>();
  private validSignatures = 0;
  private seen = 0;
  private diverged: Divergence | null = null;

  constructor(
    private readonly wallet: Wallet,
    private readonly verifier: SignatureVerifier,
  ) {}

  get headSeq(): number {
    return this.events.at(-1)?.seq ?? 0;
  }

  get divergence(): Divergence | null {
    return this.diverged;
  }

  /**
   * Adds the next events in seq order. Returns how many were accepted. Events already held are
   * skipped; a gap stops the batch (the caller lists again from headSeq). A node that cannot be
   * reached throws (WalletError NODE_UNREACHABLE) without touching the copy: retry later.
   */
  async ingest(batch: readonly StoredEvent[]): Promise<number> {
    let accepted = 0;
    for (const e of [...batch].sort((a, b) => a.seq - b.seq)) {
      if (this.diverged !== null) break;
      if (e.seq <= this.headSeq) continue;
      if (e.seq !== this.headSeq + 1) break;
      await this.decodeAll(e);
      this.seen++;
      const { inner, sig } = e.signed;
      if (this.verifier.verify(inner.author, signingMessage(inner), sig)) this.validSignatures++;
      const trip = deriveTrip(this.events, new Date(e.receivedAt));
      const verdict = validateEvent(e, trip, {
        verify: this.verifier,
        decodeInvoice: (bolt11) => {
          const inv = this.invoices.get(bolt11);
          if (inv === undefined) throw new Error('not decodable by this node');
          return inv;
        },
      });
      if (!verdict.ok) {
        this.diverged = { seq: e.seq, hash: e.hash, reason: verdict.reason };
        break;
      }
      this.events.push(e);
      accepted++;
    }
    return accepted;
  }

  private async decodeAll(e: StoredEvent): Promise<void> {
    for (const bolt11 of invoicesOf(e)) {
      if (this.invoices.has(bolt11)) continue;
      try {
        this.invoices.set(bolt11, await this.wallet.decodeInvoice(bolt11));
      } catch (err) {
        if (err instanceof WalletError && err.code === 'NODE_UNREACHABLE') throw err;
        // Not decodable: validateEvent rejects the event with that reason.
      }
    }
  }

  trip(now: Date): TripState | null {
    return deriveTrip(this.events, now);
  }

  /** "Registro verificato" (SPEC §9.5); checkpoints are compared by the routes (P1). */
  health(): LedgerHealth {
    const head = this.events.at(-1);
    return {
      events: this.seen,
      validSignatures: this.validSignatures,
      chainValid: this.diverged === null,
      headSeq: head?.seq ?? 0,
      headHash: head?.hash ?? null,
      checkpoints: null,
    };
  }
}
