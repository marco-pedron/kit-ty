import {
  signingMessage,
  type EventBody,
  type EventInner,
  type EventType,
  type StoredEvent,
} from '@kitty/shared';
import type { RelayClient } from '../relay/types.js';
import type { Wallet } from '../wallet/types.js';

// Every event an agent writes: built here, signed with the member's own wallet (SPEC §9.1),
// appended to the relay. The relay chains it; the agent trusts it only once validated locally.

const randomHex = (bytes: number) =>
  [...crypto.getRandomValues(new Uint8Array(bytes))]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');

export interface Publisher {
  wallet: Wallet;
  relay: RelayClient;
  now: () => Date;
}

export async function publishEvent<T extends EventType>(
  p: Publisher,
  tripId: string,
  type: T,
  body: EventBody<T>,
): Promise<StoredEvent> {
  const inner = {
    v: 1,
    tripId,
    type,
    author: await p.wallet.authorPubkey(),
    nonce: randomHex(16),
    createdAt: p.now().toISOString(),
    body,
  } as EventInner;
  const sig = await p.wallet.sign(signingMessage(inner));
  return p.relay.append({ inner, sig });
}
