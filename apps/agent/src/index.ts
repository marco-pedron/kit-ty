import { fileURLToPath } from 'node:url';
import { createAiService } from './ai/ai-service.js';
import { createQvacEngine } from './ai/qvac-engine.js';
import { DEMO_TRIP_PARAMS, type MemberId } from '@kitty/shared';
import { loadConfig } from './config.js';
import { FakeLightningNetwork } from './dev-fakes/fake-wallet.js';
import { fakeRegistrySeeds, realRegistrySeeds, realSetup, walletsOf } from './flows/real-setup.js';
import {
  fakeTripChannels,
  registryVersion,
  seedRegistry,
  seedTrip,
  startAgents,
  StaleRelayError,
  type AgentRuntime,
} from './flows/runtime.js';
import { FileStore } from './flows/registry-transport.js';
import { loadRates } from './flows/seed-state.js';
import { NostrTransport } from './relay/nostr-transport.js';
import { createRelayClient } from './relay/http-client.js';
import { buildAgentServer } from './server.js';

const config = loadConfig();
// Step 4 (KITTY_REGISTRY=v2): the Nostr relays of infra/docker-compose.yml, each phone's local
// copy of the registry, and how often an active member checkpoints (plan §2.6: 5 minutes in
// production; 10 s by default here, for the demo).
const NOSTR_RELAYS = (
  process.env.KITTY_NOSTR_RELAYS ?? 'ws://127.0.0.1:7001,ws://127.0.0.1:7002,ws://127.0.0.1:7003'
)
  .split(',')
  .map((u) => u.trim())
  .filter((u) => u !== '');
const REGISTRY_DIR =
  process.env.KITTY_REGISTRY_DIR ??
  fileURLToPath(new URL('../../../infra/data/registry', import.meta.url));
const CHECKPOINT_SECONDS =
  process.env.KITTY_CHECKPOINT_SECONDS === undefined
    ? undefined
    : Number(process.env.KITTY_CHECKPOINT_SECONDS);
// The routes (C3) read the runtime through a getter: it is created right below, with the
// server's logger, and the routes only answer after listen.
let runtime: AgentRuntime | null = null;
// On-device AI (SPEC §11): starts loading now, in the background. If it cannot load, the
// agent still runs: the AI is in error and the payer uses the manual form.
const ai = config.KITTY_FAKES
  ? undefined
  : createAiService({
      engine: createQvacEngine({
        speechLanguage: config.KITTY_STT_LANGUAGE,
        speechModel: config.KITTY_STT_MODEL,
      }),
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
// The timers of the trip come from the config (45/120/10 s for the live demo, SPEC §15); the
// rest of the parameters are the demo ones.
const params = {
  ...DEMO_TRIP_PARAMS,
  silentAssentSeconds: config.SILENT_ASSENT_SECONDS,
  paymentDeadlineSeconds: config.PAYMENT_DEADLINE_SECONDS,
  upheldDeadlineSeconds: config.UPHELD_DEADLINE_SECONDS,
  invoiceExpirySeconds: config.INVOICE_EXPIRY_SECONDS,
};
// KITTY_REGISTRY=v2 (23/10): the travelers on the registry v2 only, dave's node as the LSP;
// v1 (default): the legacy log with dave as coordinator, unchanged.
const registry = registryVersion(process.env.KITTY_REGISTRY);
const rt = startAgents({
  fakes: config.KITTY_FAKES,
  relay,
  wallets,
  log: app.log,
  ...(registry === 'v2' && {
    registry: {
      seeds: config.KITTY_FAKES ? fakeRegistrySeeds() : realRegistrySeeds(),
      rate: () => seed.rate,
      params,
      // Step 4: each phone on the Nostr relays, with its own complete copy on disk. With
      // KITTY_FAKES=1 the registry stays in-process and in memory (no relays, no files).
      ...(!config.KITTY_FAKES && {
        transportFor: () => new NostrTransport({ urls: NOSTR_RELAYS, log: app.log }),
        storeFor: (id: MemberId) => new FileStore(`${REGISTRY_DIR}/${id}.jsonl`),
      }),
      ...(CHECKPOINT_SECONDS !== undefined && {
        checkpointQuietMs: Math.min(3, CHECKPOINT_SECONDS) * 1000,
        checkpointEveryMs: CHECKPOINT_SECONDS * 1000,
      }),
    },
  }),
});
app.log.info(`registry ${registry}`);
runtime = rt;
app.addHook('onClose', async () => rt.stop());
const setUp =
  registry === 'v2'
    ? seedRegistry(
        rt,
        {
          tripId: 'vietnam-2026',
          name: 'Vietnam 2026',
          assetId: seed.assetId,
          ...(!config.KITTY_FAKES && { relays: NOSTR_RELAYS }),
        },
        app.log,
      )
    : seedTrip(rt, seed, params, app.log);
setUp.catch((err: unknown) => {
  app.log.error(err instanceof StaleRelayError ? err.message : `trip setup failed: ${String(err)}`);
  process.exit(1);
});

await app.listen({ host: config.AGENT_HOST, port: config.AGENT_PORT });
