import {
  DEMO_TRIP_PARAMS,
  MEMBER_IDS,
  fakeVerifier,
  signatureVerifier,
  type ActorId,
} from '@kitty/shared';
import type { RelayClient } from '../relay/types.js';
import type { Wallet } from '../wallet/types.js';
import { CoordinatorAgent } from './dave.js';
import { apiErrorOf } from './errors.js';
import { MemberAgent } from './member-agent.js';

// The running agents of the process (SPEC §14): one per actor, each with ONLY its own wallet,
// all on the same relay client, ticking every second. The routes (task C3) read and act through
// `agents`.

export interface AgentRuntime {
  agents: Map<ActorId, MemberAgent>;
  dave: CoordinatorAgent;
  stop(): void;
}

interface Log {
  info(msg: string): void;
  warn(msg: string): void;
}

export function startAgents(p: {
  fakes: boolean;
  relay: RelayClient;
  wallets: Record<ActorId, Wallet>;
  log: Log;
  tickMs?: number;
}): AgentRuntime {
  // FakeWallet signs with fakeSign; the real wallet (B3) with ed25519 (B4).
  const verifier = p.fakes ? fakeVerifier : signatureVerifier;
  const dave = new CoordinatorAgent({ wallet: p.wallets.dave, relay: p.relay, verifier });
  const agents = new Map<ActorId, MemberAgent>([['dave', dave]]);
  for (const id of MEMBER_IDS)
    agents.set(id, new MemberAgent({ actor: id, wallet: p.wallets[id], relay: p.relay, verifier }));

  const lastError = new Map<ActorId, string>();
  const timer = setInterval(() => {
    for (const [actor, agent] of agents) {
      agent.tick().then(
        () => {
          if (lastError.delete(actor)) p.log.info(`agent ${actor}: back to normal`);
        },
        (err: unknown) => {
          // Logged once per distinct error, not every second.
          const e = apiErrorOf(err);
          if (lastError.get(actor) === e.message) return;
          lastError.set(actor, e.message);
          p.log.warn(`agent ${actor}: ${e.code} ${e.message}. ${e.action}`);
        },
      );
    }
  }, p.tickMs ?? 1_000);
  return { agents, dave, stop: () => clearInterval(timer) };
}

/**
 * KITTY_FAKES=1 only: the trip of SPEC §6.1-6.2 on the fake network when the relay log is
 * empty, so `pnpm dev:fakes` has something to show (the real setup is the seed, task B2).
 * Retries until the relay answers.
 */
export async function seedFakeTrip(rt: AgentRuntime, assetId: string, log: Log): Promise<void> {
  for (;;) {
    try {
      await rt.dave.sync();
      if (rt.dave.trip() !== null) return;
      await rt.dave.createTrip({ name: 'Vietnam 2026', assetId, params: DEMO_TRIP_PARAMS });
      await rt.dave.setRate({ asOf: '2026-10-17', source: 'fake seed', rates: { VND: '26350' } });
      for (const id of MEMBER_IDS) {
        await rt.agents.get(id)?.joinTrip();
        await rt.dave.admit(id);
        await rt.dave.channelsReady(id, {
          tripChannelId: `fake-trip-${id}`,
          liquidityChannelId: `fake-liq-${id}`,
        });
      }
      log.info('fake trip "Vietnam 2026" set up on the relay');
      return;
    } catch (err) {
      const e = apiErrorOf(err);
      log.warn(`fake seed: ${e.code} ${e.message}; retrying in 2 s`);
      await new Promise((r) => setTimeout(r, 2_000));
    }
  }
}
