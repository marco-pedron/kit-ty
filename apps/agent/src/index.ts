import { loadConfig } from './config.js';
import { FakeLightningNetwork } from './dev-fakes/fake-wallet.js';
import { realSetup, walletsOf } from './flows/real-setup.js';
import {
  fakeTripChannels,
  seedTrip,
  startAgents,
  StaleRelayError,
  type AgentRuntime,
} from './flows/runtime.js';
import { loadRates } from './flows/seed-state.js';
import { createRelayClient } from './relay/http-client.js';
import { buildAgentServer } from './server.js';

const config = loadConfig();
// The routes (C3) read the runtime through a getter: it is created right below, with the
// server's logger, and the routes only answer after listen.
let runtime: AgentRuntime | null = null;
const app = buildAgentServer(config, { runtime: () => runtime });

// One relay client for the process (C2); one agent per actor on it, each with only its own
// wallet (SPEC §14).
const relay = createRelayClient({ baseUrl: config.RELAY_URL });

function fakeSetup(): ReturnType<typeof realSetup> {
  const net = new FakeLightningNetwork();
  return {
    wallets: walletsOf((a) => net.wallet(a)),
    seed: { assetId: net.assetId, channels: fakeTripChannels(), rate: loadRates() },
  };
}

const { wallets, seed } = config.KITTY_FAKES ? fakeSetup() : realSetup(config);
const rt = startAgents({ fakes: config.KITTY_FAKES, relay, wallets, log: app.log });
runtime = rt;
app.addHook('onClose', async () => rt.stop());
seedTrip(rt, seed, app.log).catch((err: unknown) => {
  app.log.error(err instanceof StaleRelayError ? err.message : `trip setup failed: ${String(err)}`);
  process.exit(1);
});

await app.listen({ host: config.AGENT_HOST, port: config.AGENT_PORT });
