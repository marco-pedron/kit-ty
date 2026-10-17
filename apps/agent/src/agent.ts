import type { ActorId } from '@kitty/shared';
import type { AiService } from './ai/types.js';
import type { Wallet } from './wallet/types.js';

// One Agent per member (SPEC §14): it holds ONLY its own member's wallet and key. The four
// agents share a process only so the AI models load once; nothing else is shared.
// Flows (expense, loop, decisions, dave's actions) are task A5.
export class Agent {
  constructor(
    readonly actor: ActorId,
    /** null until the real wallet of task B3 (or the FakeWallet with KITTY_FAKES=1). */
    readonly wallet: Wallet | null,
    /** Only travelers submit expenses; dave has no AI. */
    readonly ai: AiService | null,
  ) {}
}
