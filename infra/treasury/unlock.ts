// demo:unlock: unlock the 4 RLN nodes with the passwords saved by the seed, reconnect each
// traveller to dave and wait until every channel is usable again. After a container restart
// the nodes come back locked, and a traveller does not always reconnect by itself.
// Never prints a password.
import {
  MEMBERS,
  PEER_PORT,
  SECRETS_FILE,
  TRAVELLERS,
  loadSecrets,
  log,
  rln,
  waitFor,
} from './lib.ts';
import { unlock } from './nodes.ts';

interface NodeInfo {
  pubkey: string;
  num_channels: number;
  num_usable_channels: number;
  num_peers: number;
}

const { nodes } = loadSecrets();
for (const m of MEMBERS) {
  const password = nodes[m]?.password;
  if (!password) {
    console.error(`ERR: no password for ${m} in ${SECRETS_FILE}: run \`pnpm demo:reset\` first`);
    process.exit(1);
  }
  await unlock(m, password);
  log('unlocked', { member: m });
}

const dave = await rln<NodeInfo>('dave', '/nodeinfo');
for (const m of TRAVELLERS) {
  const { peers } = await rln<{ peers: { pubkey: string }[] }>(m, '/listpeers');
  if (!peers.some((p) => p.pubkey === dave.pubkey))
    await rln(m, '/connectpeer', {
      peer_pubkey_and_addr: `${dave.pubkey}@rln-dave:${PEER_PORT.dave}`,
    });
}

await waitFor(
  'all channels usable',
  async () => {
    for (const m of MEMBERS) {
      const i = await rln<NodeInfo>(m, '/nodeinfo');
      if (i.num_usable_channels < i.num_channels) return false;
    }
    return true;
  },
  { timeoutMs: 60_000, everyMs: 1000 },
);
for (const m of MEMBERS) {
  const i = await rln<NodeInfo>(m, '/nodeinfo');
  log('ready', {
    member: m,
    pubkey: i.pubkey,
    channels: i.num_channels,
    usable: i.num_usable_channels,
  });
}
process.exit(0);
