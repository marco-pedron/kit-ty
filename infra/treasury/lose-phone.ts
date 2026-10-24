// demo:lose-phone <member> (SPEC §12, P1): the member loses their phone. Their node is stopped
// (its data is kept, and infra:up refuses to start it again until demo:reset: an old channel
// state must never come back online), a NEW empty node takes its place on the same ports and
// network name, and is restored from the latest encrypted backup the agent put on the relay.
// Then the balance must be the same as before. Never prints a password.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  INFRA_DIR,
  MEMBERS,
  OUT_DIR,
  PEER_PORT,
  type Member,
  loadSecrets,
  log,
  nodeUrl,
  rln,
  unlockBody,
  waitFor,
} from './lib.ts';

const m = process.argv[2] as Member;
if (!MEMBERS.includes(m)) {
  console.error(`usage: pnpm demo:lose-phone <${MEMBERS.join('|')}>`);
  process.exit(2);
}
const RELAY_URL = (process.env.RELAY_URL || 'http://127.0.0.1:4000').replace(/\/+$/u, '');
const marker = join(OUT_DIR, `lost-${m}`);
if (existsSync(marker)) {
  console.error(`ERR: ${m} already lost their phone: run \`pnpm demo:reset\` to start again`);
  process.exit(1);
}
const compose = (...args: string[]) =>
  execFileSync('docker', ['compose', '-f', join(INFRA_DIR, 'docker-compose.yml'), ...args], {
    stdio: ['ignore', 'pipe', 'inherit'],
  });

interface NodeInfo {
  pubkey: string;
  num_channels: number;
  num_usable_channels: number;
  num_peers: number;
}
interface Balance {
  settled: number;
  offchain_outbound: number;
  offchain_inbound: number;
}
const { assetId } = JSON.parse(readFileSync(join(OUT_DIR, 'seed-state.json'), 'utf8')) as {
  assetId: string;
};
const balance = async () => {
  await rln(m, '/refreshtransfers', { skip_sync: false }).catch(() => undefined);
  const b = await rln<Balance>(m, '/assetbalance', { asset_id: assetId });
  return { settled: b.settled, outbound: b.offchain_outbound, inbound: b.offchain_inbound };
};

// 1. the phone before: identity and balance
const before = await rln<NodeInfo>(m, '/nodeinfo');
const balanceBefore = await balance();
log('before', {
  member: m,
  pubkey: before.pubkey,
  channels: before.num_channels,
  ...balanceBefore,
});

// 2. the latest backup on the relay (the agent uploads one 10 s after every change)
const res = await fetch(`${RELAY_URL}/backups/${before.pubkey}`);
if (res.status !== 200) {
  console.error(
    `ERR: no backup of ${m} on the relay ${RELAY_URL} (HTTP ${res.status}): start the agents (pnpm dev) and wait for it`,
  );
  process.exit(1);
}
const blob = Buffer.from(await res.arrayBuffer());
log('backup on the relay', {
  bytes: blob.length,
  version: res.headers.get('x-backup-version'),
  createdAt: res.headers.get('x-backup-created-at'),
});

// 3. the phone is lost: the node stops for good
mkdirSync(OUT_DIR, { recursive: true });
writeFileSync(marker, `${new Date().toISOString()} ${before.pubkey}\n`);
compose('stop', `rln-${m}`);
log('lost', { member: m, node: `rln-${m} stopped, never to be started again` });

// 4. a new phone: an empty node on the same ports and network name
const file = `restore-${Date.now()}.bin`;
const hostDir = join(INFRA_DIR, 'data', 'backups', m);
mkdirSync(hostDir, { recursive: true });
writeFileSync(join(hostDir, file), blob);
compose('--profile', 'lose-phone', 'up', '-d', `rln-${m}-restored`);
await waitFor(
  `the new node of ${m}`,
  async () => (await fetch(`${nodeUrl(m)}/nodeinfo`).catch(() => null)) !== null,
  { timeoutMs: 60_000, everyMs: 1000 },
);

// 5. restore from the backup with the node's own password, then unlock
const password = loadSecrets().nodes[m]?.password;
if (!password) throw new Error(`no password for ${m} in the secrets file`);
await rln(m, '/restore', { backup_path: `/backups/${file}`, password });
await rln(m, '/unlock', unlockBody(m, password));
log('restored', { member: m });

// 6. the same node, its channels usable again (a traveler reconnects to dave if needed)
const daveInfo = await rln<NodeInfo>('dave', '/nodeinfo');
let reconnected = false;
const after = await waitFor(
  'channels usable after the restore',
  async () => {
    const i = await rln<NodeInfo>(m, '/nodeinfo');
    if (i.num_channels > 0 && i.num_usable_channels === i.num_channels) return i;
    if (m !== 'dave' && !reconnected && i.num_peers === 0) {
      reconnected = true;
      await rln(m, '/connectpeer', {
        peer_pubkey_and_addr: `${daveInfo.pubkey}@rln-dave:${PEER_PORT.dave}`,
      }).catch(() => undefined);
    }
    return false;
  },
  { timeoutMs: 60_000, everyMs: 1000 },
);
const balanceAfter = await balance();
log('after', { member: m, pubkey: after.pubkey, channels: after.num_channels, ...balanceAfter });

const same =
  after.pubkey === before.pubkey &&
  after.num_channels === before.num_channels &&
  JSON.stringify(balanceAfter) === JSON.stringify(balanceBefore);
if (!same) {
  console.error('ERR: the restored node differs from the lost one (see before/after above)');
  process.exit(1);
}
console.log(
  `\n${m}'s new phone: same node, ${after.num_channels} channels usable, same balance ` +
    `(${(balanceAfter.outbound / 100).toFixed(2)} DUSD to spend in the channels, ` +
    `${(balanceAfter.settled / 100).toFixed(2)} on-chain).`,
);
// KITTY_REGISTRY=v2 (step 4): the new phone has no copy of the registry either. The app,
// installed again with the same seed, finds the trip from the relays alone.
if (process.env.KITTY_REGISTRY === 'v2' && m !== 'dave') {
  const agent = (process.env.AGENT_URL || 'http://127.0.0.1:4100').replace(/\/+$/u, '');
  const r = await fetch(`${agent}/api/${m}/restore-from-seed`, { method: 'POST' });
  const body = (await r.json()) as { events?: number; error?: { message?: string } };
  if (!r.ok || typeof body.events !== 'number') {
    console.error(
      `ERR: ${m}'s registry not restored from the seed: ${body.error?.message ?? r.status}`,
    );
    process.exit(1);
  }
  console.log(`${m}'s registry found again from the seed on the relays: ${body.events} events.`);
}
process.exit(0);
