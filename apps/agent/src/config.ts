import { RailModeSchema } from '@kitty/shared';
import { z } from 'zod';

// Agent configuration from the environment, validated once at start (see .env.example of B1).
// Hosts default to 127.0.0.1: node APIs are never exposed (SPEC §13 #13).

const url = (fallback: string) => z.url().default(fallback);
const seconds = (fallback: number) => z.coerce.number().int().positive().default(fallback);

export const ConfigSchema = z.object({
  KITTY_FAKES: z
    .enum(['0', '1'])
    .default('0')
    .transform((v) => v === '1'),
  KITTY_RAIL_MODE: RailModeSchema.default('ln-2ch'),
  KITTY_WALLET_ENGINE: z.enum(['rln-rest', 'wdk']).default('rln-rest'),
  AGENT_HOST: z.string().default('127.0.0.1'),
  AGENT_PORT: z.coerce.number().int().min(1).max(65535).default(4100),
  RELAY_URL: url('http://127.0.0.1:4000'),
  RLN_ALICE_URL: url('http://127.0.0.1:3001'),
  RLN_BOB_URL: url('http://127.0.0.1:3002'),
  RLN_CHARLIE_URL: url('http://127.0.0.1:3003'),
  RLN_DAVE_URL: url('http://127.0.0.1:3004'),
  ESPLORA_URL: url('http://127.0.0.1:3010'),
  // Timers of SPEC §15, written into TRIP_CREATED by index.ts: live demo 45/120 s (production
  // is hours), and 10 s to pay a line dave upheld, so the default follows on stage. Tests and
  // e2e:demo pin 20/30/30 s (DEMO_TRIP_PARAMS, e2e/harness.ts).
  SILENT_ASSENT_SECONDS: seconds(45),
  PAYMENT_DEADLINE_SECONDS: seconds(120),
  UPHELD_DEADLINE_SECONDS: seconds(10),
  INVOICE_EXPIRY_SECONDS: seconds(3600),
  // Whisper takes one language at load time (QVAC 0.21): the language the payer dictates in.
  KITTY_STT_LANGUAGE: z.enum(['en', 'it']).default('en'),
  KITTY_STT_MODEL: z
    .enum(['WHISPER_BASE_Q8_0', 'WHISPER_SMALL_Q8_0'])
    .default('WHISPER_SMALL_Q8_0'),
});

export type Config = z.output<typeof ConfigSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const r = ConfigSchema.safeParse(env);
  if (!r.success) throw new Error(`invalid agent configuration:\n${z.prettifyError(r.error)}`);
  return r.data;
}

/** The RLN URL of each actor's own node: an agent gets only its own (SPEC §14). */
export function nodeUrls(c: Config): Record<'alice' | 'bob' | 'charlie' | 'dave', string> {
  return {
    alice: c.RLN_ALICE_URL,
    bob: c.RLN_BOB_URL,
    charlie: c.RLN_CHARLIE_URL,
    dave: c.RLN_DAVE_URL,
  };
}
