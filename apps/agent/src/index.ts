import { loadConfig } from './config.js';
import { FakeLightningNetwork } from './dev-fakes/fake-wallet.js';
import { realSetup, walletsOf } from './flows/real-setup.js';
import { fakeTripChannels, seedTrip, startAgents, StaleRelayError } from './flows/runtime.js';
import { loadRates } from './flows/seed-state.js';
import { createRelayClient } from './relay/http-client.js';
import { buildAgentServer } from './server.js';

const config = loadConfig();
const app = buildAgentServer(config);

// One relay client for the process (C2); one agent per actor on it, each with only its own
// wallet (SPEC §14). The routes are wired to `runtime.agents` by task C3.
const relay = createRelayClient({ baseUrl: config.RELAY_URL });

function fakeSetup(): ReturnType<typeof realSetup> {
  const net = new FakeLightningNetwork();
  return {
    wallets: walletsOf((a) => net.wallet(a)),
    seed: { assetId: net.assetId, channels: fakeTripChannels(), rate: loadRates() },
  };
}

const { wallets, seed } = config.KITTY_FAKES ? fakeSetup() : realSetup(config);
const runtime = startAgents({ fakes: config.KITTY_FAKES, relay, wallets, log: app.log });
app.addHook('onClose', async () => runtime.stop());
seedTrip(runtime, seed, app.log).catch((err: unknown) => {
  app.log.error(err instanceof StaleRelayError ? err.message : `trip setup failed: ${String(err)}`);
  process.exit(1);
});

await app.listen({ host: config.AGENT_HOST, port: config.AGENT_PORT });
