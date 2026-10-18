import { createAiService } from './ai/ai-service.js';
import { createQvacEngine } from './ai/qvac-engine.js';
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
import { dockerMiner } from './wallet/chain.js';
import { SwapWatcher } from './wallet/swap-watcher.js';

const config = loadConfig();
// The routes (C3) read the runtime through a getter: it is created right below, with the
// server's logger, and the routes only answer after listen.
let runtime: AgentRuntime | null = null;
// On-device AI (SPEC §11): starts loading now, in the background. If it cannot load, the
// agent still runs: the AI is in error and the payer uses the manual form.
const ai = config.KITTY_FAKES
  ? undefined
  : createAiService({
      engine: createQvacEngine(),
      log: { info: (m) => app.log.info(m), error: (m) => app.log.error(m) },
    });
const app = buildAgentServer(config, { runtime: () => runtime, ...(ai && { ai }) });

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

// EXPERIMENT ln-1ch-swap: dave's agent watches the onboarding swaps and claims each on-chain HTLC
// with the preimage before T (experiments/kaleidoswap/RESULTS.md). Started on its own: if it is
// down until T, dave loses D.
if (!config.KITTY_FAKES && config.KITTY_RAIL_MODE === 'ln-1ch-swap') {
  const env = process.env;
  if (!env.KK_RUN_DIR || !env.KK_BITCOIND_URL || !env.KK_NETWORK)
    throw new Error('ln-1ch-swap needs KK_RUN_DIR, KK_BITCOIND_URL, KK_NETWORK (env-1ch.sh)');
  const watcher = new SwapWatcher({
    runDir: env.KK_RUN_DIR,
    daveNodeUrl: config.RLN_DAVE_URL,
    bitcoindUrl: env.KK_BITCOIND_URL,
    dockerNetwork: env.KK_NETWORK,
    assetId: seed.assetId,
    miner: dockerMiner,
    log: { info: (m) => app.log.info(m), error: (m) => app.log.error(m) },
  });
  watcher.start();
  app.addHook('onClose', async () => watcher.stop());
}
seedTrip(rt, seed, app.log).catch((err: unknown) => {
  app.log.error(err instanceof StaleRelayError ? err.message : `trip setup failed: ${String(err)}`);
  process.exit(1);
});

await app.listen({ host: config.AGENT_HOST, port: config.AGENT_PORT });
