import { formatCents, type ActivityItem, type ApiError, type OperationView } from '@kitty/shared';
import type { PeerChannel, Wallet } from '../wallet/types.js';
import { apiErrorOf } from './errors.js';

// dave with KITTY_REGISTRY=v2 (21/10, 23/10): only the LSP of the demo. He is not a member: he
// is not invited, signs no event and never reads the registry. His node routes the payments;
// his agent only keeps enough liquidity on each member's side, looking at his own channels, as
// the Utexo LSP will. The app and the ledger do not know it is dave.

/** Below this, the LSP opens more liquidity to the peer (as SPEC §10.5's threshold). */
export const LSP_THRESHOLD_CENTS = 1000n;

export interface LspNeed {
  peerPubkey: string;
  /** What the peer can receive now: the LSP's side of its usable channels with the peer. */
  inboundCents: bigint;
  /** To open now so the peer can receive `targetCents` again; 0n when enough. */
  openCents: bigint;
}

/**
 * The liquidity rule of the LSP, from its channels alone: per peer with an open channel, what
 * the peer can receive; below `thresholdCents`, open up to `targetCents`. Peers with a channel
 * opening or closing are left alone (an opening is on its way; a closing peer is leaving).
 * Limit: the LSP cannot see the lines to come, so it tops up after a payment, not before it.
 */
export function lspLiquidityPlan(
  channels: readonly PeerChannel[],
  thresholdCents: bigint,
  targetCents: bigint,
): LspNeed[] {
  const peers = new Map<string, PeerChannel[]>();
  for (const c of channels) peers.set(c.peerPubkey, [...(peers.get(c.peerPubkey) ?? []), c]);
  const out: LspNeed[] = [];
  for (const [peerPubkey, list] of peers) {
    if (list.some((c) => c.status !== 'Opened')) continue;
    const inboundCents = list.filter((c) => c.usable).reduce((a, c) => a + c.localCents, 0n);
    const openCents = inboundCents < thresholdCents ? targetCents - inboundCents : 0n;
    out.push({ peerPubkey, inboundCents, openCents });
  }
  return out.sort((a, b) => a.peerPubkey.localeCompare(b.peerPubkey));
}

const MAX_KEPT = 50;

export class LspAgent {
  readonly actor = 'dave' as const;
  private readonly wallet: Wallet;
  private readonly now: () => Date;
  private readonly thresholdCents: bigint;
  private readonly targetCents: bigint;
  private readonly retryMs: number;
  private opening: Promise<void> | null = null;
  private retryAt = 0;
  private ticking = false;
  private readonly ops: OperationView[] = [];
  private readonly activityItems: ActivityItem[] = [];
  private opCounter = 0;

  constructor(o: {
    wallet: Wallet;
    /** L of SPEC §15: what each member can receive at the start (30.00). */
    targetCents: bigint;
    thresholdCents?: bigint;
    now?: () => Date;
    retryMs?: number;
  }) {
    this.wallet = o.wallet;
    this.targetCents = o.targetCents;
    this.thresholdCents = o.thresholdCents ?? LSP_THRESHOLD_CENTS;
    this.now = o.now ?? (() => new Date());
    this.retryMs = o.retryMs ?? 10_000;
  }

  operations(): readonly OperationView[] {
    return this.ops;
  }

  activity(): readonly ActivityItem[] {
    return this.activityItems;
  }

  async idle(): Promise<void> {
    while (this.opening !== null) await this.opening;
  }

  /** What the rule says now (null if the node cannot list its channels). */
  async needs(): Promise<LspNeed[] | null> {
    if (this.wallet.peerChannels === undefined) return null;
    return lspLiquidityPlan(
      await this.wallet.peerChannels(),
      this.thresholdCents,
      this.targetCents,
    );
  }

  /** One opening at a time, in the background; a failure is retried after retryMs. */
  async tick(): Promise<void> {
    if (this.ticking || this.opening !== null || this.now().getTime() < this.retryAt) return;
    this.ticking = true;
    try {
      const need = (await this.needs())?.find((n) => n.openCents > 0n);
      if (need === undefined) return;
      const op = this.startOp(
        'opening_liquidity',
        `Opening ${formatCents(need.openCents)} of liquidity to ${need.peerPubkey.slice(0, 8)}…`,
      );
      this.opening = this.wallet
        .openLiquidity(need.peerPubkey, need.openCents)
        .then(({ channelId }) => {
          this.endOp(op, 'done');
          this.activityItems.unshift({
            at: this.now().toISOString(),
            kind: 'AGENT',
            text: `Opened ${formatCents(need.openCents)} of liquidity to ${need.peerPubkey.slice(0, 8)}… (channel ${channelId.slice(0, 8)}…): it could receive ${formatCents(need.inboundCents)}.`,
            expenseId: null,
            proof: null,
          });
          this.activityItems.length = Math.min(this.activityItems.length, MAX_KEPT);
        })
        .catch((err: unknown) => {
          this.retryAt = this.now().getTime() + this.retryMs;
          this.endOp(op, 'failed', apiErrorOf(err));
        })
        .finally(() => {
          this.opening = null;
        });
    } finally {
      this.ticking = false;
    }
  }

  private startOp(kind: OperationView['kind'], text: string): OperationView {
    const op: OperationView = {
      id: `dave-${++this.opCounter}`,
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
