// EXPERIMENT seed of KITTY_RAIL_MODE=ln-1ch-swap (branch experiment/rgb-lightning-node): ONE
// channel per traveler, opened by dave with D + L, and the traveler's D brought in with an atomic
// on-chain <-> LN swap (experiments/kaleidoswap/RESULTS.md). Runs on the kitty-1ch stack only
// (infra/scripts/env-1ch.sh), from `pnpm demo:reset:1ch`. Never prints passwords or mnemonics.
//
// Order matters (RESULTS.md §5.4, docs/spike-wdk.md trap 6): dave's DUSD come as SEPARATE
// allocations, one per channel; the channels open BEFORE the travelers' on-ramp and dave's
// reserve, so no open picks an allocation another open needs.
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { assertNoFakesFromAgent } from './no-fakes.ts';
import {
  type Member,
  esploraHasTx,
  mineAndSync,
  MEMBERS,
  PEER_PORT,
  TRAVELLERS,
  fund,
  log,
  rln,
  saveSecrets,
  waitFor,
  type Secrets,
} from './lib.ts';
import { createUtxos, fundNode, initAndUnlock } from './nodes.ts';
import { assetBalance, newTreasuryMnemonic, onramp, openTreasury } from './treasury.ts';
import { tool } from '../../experiments/kaleidoswap/src/htlc.ts';
import { sendBtc, mine as rpcMine } from '../../experiments/kaleidoswap/src/lib.ts';
import {
  daveOffer,
  davePay,
  daveVerify,
  daveWatcherTick,
  getPayment,
  setAssetId,
  travelerClaimLn,
  travelerInvoice,
  travelerLock,
  travelerPropose,
} from '../../experiments/kaleidoswap/src/swap.ts';

if (process.env.KITTY_STACK !== '1ch')
  throw new Error('seed-1ch runs only on the kitty-1ch stack: source infra/scripts/env-1ch.sh');
const SEED_STATE_FILE = process.env.KITTY_SEED_STATE_FILE!;
await assertNoFakesFromAgent();

const ISSUED = 1_000_000; // 10,000.00 on the treasury
const ONRAMP = 10_000; // 100.00 per traveller
const D = 5_000; // the traveller's side after the swap (SPEC §15)
const L = 3_000; // dave's side after the swap
const DAVE_RESERVE = 20_000;
const CAPACITY_SAT = 1_000_000;
const PUSH_MSAT = 300_000_000; // BTC for the traveller's payments: dave funds the whole channel
const CHANNEL_UTXO_SAT = 1_100_000;

const t0 = Date.now();
const secrets: Secrets = { nodes: {}, treasuryMnemonic: newTreasuryMnemonic() };
saveSecrets(secrets);

// 1. nodes
const pubkey = {} as Record<Member, string>;
for (const m of MEMBERS) pubkey[m] = await initAndUnlock(m, secrets);

// 2. BTC: nodes, treasury, and the rgb-lib HTLC wallets (fees of lock refund and claim)
const treasury = await openTreasury(secrets.treasuryMnemonic!);
fund(await treasury.account.getAddress(), '1');
for (const m of MEMBERS) await fundNode(m, '1');
for (const w of ['dave-htlc', ...TRAVELLERS.map((m) => `${m}-htlc`)])
  await sendBtc(tool('address', { wallet: w }).address, 0.02);
await mineAndSync(1);

// 3. colorable UTXOs; dave funds every channel: one big UTXO per channel plus a spare
const made = await treasury.account.createUtxos({ upTo: false, num: 10, size: 32_000, feeRate: 2 });
log('treasury createUtxos', { made });
for (const m of MEMBERS) await createUtxos(m, 10);
await createUtxos('dave', TRAVELLERS.length + 1, CHANNEL_UTXO_SAT);
await mineAndSync(1);

// 4. DUSD on the WDK treasury (NIA, precision 2), as on main
const asset = treasury.account.issueAssetNia({
  ticker: 'DUSD',
  name: 'Demo Dollar',
  precision: 2,
  amounts: [ISSUED],
});
const assetId: string = asset.assetId;
setAssetId(assetId);
log('issued DUSD', { assetId, units: ISSUED });

// 5. dave: one allocation of D + L per channel, each its own transfer (separate UTXOs)
const onrampTxids: { to: Member; amount: number; txid: string }[] = [];
for (let i = 0; i < TRAVELLERS.length; i++)
  onrampTxids.push({
    to: 'dave',
    amount: D + L,
    txid: await onramp(treasury.account, assetId, 'dave', D + L),
  });

// 6. one channel dave → each traveller, D + L on dave's side, before any other DUSD move
interface Channel {
  channel_id: string;
  funding_txid: string | null;
  peer_pubkey: string;
  ready: boolean;
  is_usable: boolean;
  capacity_sat: number;
  local_balance_sat: number;
  asset_id: string | null;
  asset_local_amount: number | null;
  asset_remote_amount: number | null;
}
const listChannels = async (m: Member) =>
  (await rln<{ channels: Channel[] }>(m, '/listchannels')).channels;
const addr = (m: Member) => `${pubkey[m]}@rln-${m}:${PEER_PORT[m]}`;

async function openOne(peer: Member): Promise<void> {
  for (let attempt = 1; attempt <= 3; attempt++) {
    const before = new Set((await listChannels('dave')).map((c) => c.channel_id));
    try {
      await rln('dave', '/openchannel', {
        peer_pubkey_and_opt_addr: addr(peer),
        capacity_sat: CAPACITY_SAT,
        push_msat: PUSH_MSAT,
        asset_amount: D + L,
        asset_id: assetId,
        public: true,
        with_anchors: true,
        fee_base_msat: 0,
        fee_proportional_millionths: 0,
      });
      const txid = await waitFor(
        `funding tx dave → ${peer}`,
        async () => {
          const ch = (await listChannels('dave')).find(
            (c) => !before.has(c.channel_id) && c.peer_pubkey === pubkey[peer],
          );
          return ch?.funding_txid && (await esploraHasTx(ch.funding_txid))
            ? ch.funding_txid
            : false;
        },
        { timeoutMs: 60_000, everyMs: 1000 },
      );
      await mineAndSync(1);
      log('channel funded', { peer, assetAmount: D + L, fundingTxid: txid });
      return;
    } catch (e) {
      if (attempt >= 3) throw e;
      log('openchannel retry', { peer, attempt, error: (e as Error).message });
      await mineAndSync(1);
    }
  }
}
for (const m of TRAVELLERS) await openOne(m);
await mineAndSync(6);
await waitFor(
  '3 channels usable on both sides, 3 channels in every graph',
  async () => {
    const daves = (await listChannels('dave')).filter((c) => c.ready && c.is_usable);
    const sides = await Promise.all(
      TRAVELLERS.map(async (m) => (await listChannels(m)).some((c) => c.is_usable)),
    );
    const graphs = await Promise.all(
      TRAVELLERS.map(
        async (m) => (await rln<{ network_channels: number }>(m, '/nodeinfo')).network_channels,
      ),
    );
    if (daves.length === 3 && sides.every(Boolean) && graphs.every((n) => n >= 3)) return true;
    log('waiting for channels', { daveUsable: daves.length, graphs });
    await mineAndSync(1);
    return false;
  },
  { timeoutMs: 180_000, everyMs: 3000 },
);

// 7. on-ramp of the travellers and dave's reserve, now that the opens are confirmed
for (const m of TRAVELLERS)
  onrampTxids.push({
    to: m,
    amount: ONRAMP,
    txid: await onramp(treasury.account, assetId, m, ONRAMP),
  });
onrampTxids.push({
  to: 'dave',
  amount: DAVE_RESERVE,
  txid: await onramp(treasury.account, assetId, 'dave', DAVE_RESERVE),
});
treasury.dispose();

// 8. the atomic swap per traveller: D on-chain (HTLC) ↔ D on the traveller's side of the channel
const swaps: Record<string, unknown> = {};
for (const m of TRAVELLERS) {
  const id = `swap-${m}`;
  const s = travelerPropose(id, m, D);
  const d = await daveOffer(id, m, pubkey[m], s.refundKey, D);
  const terms = { hash: s.hash, claim: d.claimKey, refund: s.refundKey, timeout: d.timeout };
  await travelerLock(s, terms);
  const invoice = await travelerInvoice(s);
  const verdict = await daveVerify(d, {
    invoice,
    announced: terms,
    outpoint: s.lock!.outpoint,
    blinding: s.lock!.blinding,
  });
  if (!verdict.pay)
    throw new Error(`dave refuses the swap of ${m}: ${verdict.failures.join('; ')}`);
  await davePay(d, invoice);
  await waitFor(
    `${m} sees the HODL payment Claimable`,
    async () => (await getPayment(m, s.hash, 'InboundHodl'))?.status === 'Claimable',
    { timeoutMs: 60_000, everyMs: 500 },
  );
  await travelerClaimLn(s);
  await waitFor(
    'dave sees the preimage',
    async () => !!(await getPayment('dave', s.hash, 'Outbound'))?.preimage,
    { timeoutMs: 60_000, everyMs: 500 },
  );
  // the same pass the agent's watcher runs (apps/agent/src/wallet/swap-watcher.ts)
  const did = await daveWatcherTick();
  log('swap done', { traveller: m, did });
  swaps[m] = {
    hash: s.hash,
    preimage: s.preimage,
    lockTxid: s.lock!.txid,
    timeout: d.timeout,
    amount: D,
  };
}
await rpcMine(1);

// 9. checks and the non-secret seed state for the agent (one channel = travel AND liquidity)
for (const m of MEMBERS)
  await rln(m, '/refreshtransfers', { asset_id: null, filter: [], skip_sync: false });
const dusd = (u: number | null) => {
  const s = String(u ?? 0).padStart(3, '0');
  return `${s.slice(0, -2)}.${s.slice(-2)}`;
};
const problems: string[] = [];
const members: Record<string, unknown> = {};
console.log('\nBalances after the 1ch seed (DUSD):');
for (const m of MEMBERS) {
  const bal = await assetBalance(m, assetId);
  const chans = await listChannels(m);
  const peerOf = (pk: string) => MEMBERS.find((x) => pubkey[x] === pk) ?? pk;
  const channels =
    m === 'dave'
      ? chans.map((c) => ({
          kind: 'liquidity',
          peer: peerOf(c.peer_pubkey),
          channelId: c.channel_id,
        }))
      : chans.flatMap((c) => [
          { kind: 'travel', peer: peerOf(c.peer_pubkey), channelId: c.channel_id },
          { kind: 'liquidity', peer: peerOf(c.peer_pubkey), channelId: c.channel_id },
        ]);
  members[m] = { pubkey: pubkey[m], onchain: bal, channels };
  console.log(
    `  ${m.padEnd(8)} on-chain ${dusd(bal.settled)}, off-chain out ${dusd(bal.offchain_outbound)} in ${dusd(bal.offchain_inbound)}, ${chans.length} channel(s)`,
  );
  if (m === 'dave') {
    if (bal.settled !== DAVE_RESERVE)
      problems.push(`dave on-chain ${bal.settled} != ${DAVE_RESERVE}`);
    continue;
  }
  if (chans.length !== 1) problems.push(`${m} has ${chans.length} channels, want 1`);
  const c = chans[0];
  if (c?.asset_local_amount !== D || c?.asset_remote_amount !== L)
    problems.push(`${m} channel ${c?.asset_local_amount}/${c?.asset_remote_amount} != ${D}/${L}`);
  if (bal.settled !== ONRAMP - D) problems.push(`${m} on-chain ${bal.settled} != ${ONRAMP - D}`);
}

mkdirSync(dirname(SEED_STATE_FILE), { recursive: true });
writeFileSync(
  SEED_STATE_FILE,
  JSON.stringify(
    {
      createdAt: new Date().toISOString(),
      railMode: 'ln-1ch-swap',
      assetId,
      pubkeys: pubkey,
      onramp: onrampTxids,
      swaps,
      members,
    },
    null,
    2,
  ) + '\n',
);
if (problems.length) {
  console.error('\nSEED 1CH FAILED CHECKS:\n  ' + problems.join('\n  '));
  process.exit(1);
}
console.log(`\nseed 1ch done in ${Math.round((Date.now() - t0) / 1000)} s, asset ${assetId}`);
console.log(`seed state: ${SEED_STATE_FILE}`);
process.exit(0);
