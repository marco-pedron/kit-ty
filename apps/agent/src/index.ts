import { ActorIdSchema, type ActorId } from '@kitty/shared';
import { loadConfig, nodeUrls } from './config.js';
import { FakeLightningNetwork } from './dev-fakes/fake-wallet.js';
import { fakeTripChannels, seedTrip, startAgents, StaleRelayError } from './flows/runtime.js';
import { loadRates, loadSeedState } from './flows/seed-state.js';
import { createRelayClient } from './relay/http-client.js';
import { buildAgentServer } from './server.js';
import { RlnWallet } from './wallet/rln-wallet.js';
import { loadMemberWalletOptions } from './wallet/secrets.js';
import type { Wallet } from './wallet/types.js';

const config = loadConfig();
const app = buildAgentServer(config);

// One relay client for the process (C2); one agent per actor on it, each with only its own
// wallet (SPEC §14). The routes are wired to `runtime.agents` by task C3.
const relay = createRelayClient({ baseUrl: config.RELAY_URL });
const rate = loadRates();

let wallets: Record<ActorId, Wallet>;
let seed: Parameters<typeof seedTrip>[1];
if (config.KITTY_FAKES) {
  const net = new FakeLightningNetwork();
  wallets = walletsOf((a) => net.wallet(a));
  seed = { assetId: net.assetId, channels: fakeTripChannels(), rate };
} else {
  // The real nodes of the seed (B2): each wallet reads only its own member's secrets (B3).
  const urls = nodeUrls(config);
  wallets = walletsOf((a) => new RlnWallet(loadMemberWalletOptions(a, { nodeUrl: urls[a] })));
  const state = loadSeedState();
  seed = { assetId: state.assetId, channels: state.channels, rate };
}

function walletsOf(make: (a: ActorId) => Wallet): Record<ActorId, Wallet> {
  const w = {} as Record<ActorId, Wallet>;
  for (const a of ActorIdSchema.options) w[a] = make(a);
  return w;
}

const runtime = startAgents({ fakes: config.KITTY_FAKES, relay, wallets, log: app.log });
app.addHook('onClose', async () => runtime.stop());
seedTrip(runtime, seed, app.log).catch((err: unknown) => {
  app.log.error(err instanceof StaleRelayError ? err.message : `trip setup failed: ${String(err)}`);
  process.exit(1);
});

await app.listen({ host: config.AGENT_HOST, port: config.AGENT_PORT });
