import { ActorIdSchema, type ActorId } from '@kitty/shared';
import { loadConfig } from './config.js';
import { FakeLightningNetwork } from './dev-fakes/fake-wallet.js';
import { seedFakeTrip, startAgents } from './flows/runtime.js';
import { createRelayClient } from './relay/http-client.js';
import { buildAgentServer } from './server.js';
import type { Wallet } from './wallet/types.js';

const config = loadConfig();
const app = buildAgentServer(config);

// One relay client for the process (C2); one agent per actor on it, each with only its own
// wallet (SPEC §14). The routes are wired to `runtime.agents` by task C3.
const relay = createRelayClient({ baseUrl: config.RELAY_URL });
const net = config.KITTY_FAKES ? new FakeLightningNetwork() : null;
const wallets = net === null ? null : walletsOf(net);

function walletsOf(n: FakeLightningNetwork): Record<ActorId, Wallet> {
  const w = {} as Record<ActorId, Wallet>;
  for (const a of ActorIdSchema.options) w[a] = n.wallet(a);
  return w;
}

if (wallets === null) {
  app.log.warn('no real wallet yet (task B3): agent loops not started; run with KITTY_FAKES=1');
} else {
  const runtime = startAgents({ fakes: config.KITTY_FAKES, relay, wallets, log: app.log });
  if (net !== null) void seedFakeTrip(runtime, net.assetId, app.log);
  app.addHook('onClose', async () => runtime.stop());
}

await app.listen({ host: config.AGENT_HOST, port: config.AGENT_PORT });
