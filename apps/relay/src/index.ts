import { fakeVerifier, signatureVerifier } from '@kitty/shared';
import { openRelayDb } from './db.js';
import { buildRelay, defaultDeps } from './server.js';

const host = process.env.RELAY_HOST ?? '127.0.0.1';
const port = Number.parseInt(process.env.RELAY_PORT ?? '4000', 10);
// One file per trip; demo:reset deletes it.
const dbPath = process.env.RELAY_DB ?? 'data/relay.sqlite';
const fakes = process.env.KITTY_FAKES === '1';

const app = buildRelay({
  db: openRelayDb(dbPath),
  deps: { ...defaultDeps, verify: fakes ? fakeVerifier : signatureVerifier },
});
if (fakes) app.log.warn('KITTY_FAKES=1: the relay accepts forgeable fake signatures');
await app.listen({ host, port });
