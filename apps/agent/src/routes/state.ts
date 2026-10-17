// OWNED BY STREAM C (task C3). Contract-session skeleton: an empty TripView, so the UI can be
// built against the real schema from day one. The real view comes from deriveTrip (A1).
import {
  DEFAULT_POLICY,
  isMemberId,
  roleOf,
  type ActorId,
  type AiStatus,
  type TripView,
} from '@kitty/shared';
import type { Agent } from '../agent.js';

export function emptyTripView(
  agent: Agent,
  opts: { fakes: boolean; explorerBaseUrl: string; now: Date },
): TripView {
  const as: ActorId = agent.actor;
  const ai: AiStatus = { status: agent.ai?.status() ?? 'loading', fake: opts.fakes };
  return {
    as,
    role: roleOf(as),
    fakes: opts.fakes,
    serverNow: opts.now.toISOString(),
    trip: null,
    rate: null,
    members: [],
    me: isMemberId(as)
      ? {
          memberId: as,
          policy: DEFAULT_POLICY,
          balance: null,
          oweCents: 0n,
          owedToMeCents: 0n,
          autoPaidTodayCents: 0n,
          debts: [],
          credits: [],
        }
      : null,
    coordinator: as === 'dave' ? { members: [], disputes: [], defaults: [] } : null,
    expenses: [],
    activity: [],
    operations: [],
    ai,
    ledger: {
      events: 0,
      validSignatures: 0,
      chainValid: true,
      headSeq: 0,
      headHash: null,
      checkpoints: null,
    },
    explorerBaseUrl: opts.explorerBaseUrl,
  };
}
