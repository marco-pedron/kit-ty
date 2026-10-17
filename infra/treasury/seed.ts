// B2 seed: from a freshly reset stack to a trip ready for the demo (SPEC §6.1, §6.2, §15).
// Run by `pnpm demo:reset` after infra:reset; it never prints passwords or mnemonics.
import { assertNoFakesFromAgent } from './no-fakes.ts';
import {
  type Member,
  esploraHasTx,
  mineAndSync,
  MEMBERS,
  PEER_PORT,
  RlnError,
  TRAVELLERS,
  fund,
  log,
  rln,
  saveSecrets,
  waitFor,
  writeOut,
  type Secrets,
} from './lib.ts';
import { createUtxos, fundNode, initAndUnlock } from './nodes.ts';
import { assetBalance, newTreasuryMnemonic, onramp, openTreasury } from './treasury.ts';

await assertNoFakesFromAgent();

// DUSD minimal units (precision 2): 1 = 0.01 DUSD.
const ISSUED = 1_000_000; // 10,000.00 on the treasury
const ONRAMP = 10_000; // 100.00 per traveller
const D = 5_000; // travel channel, opened by the traveller
const L = 3_000; // liquidity channel, opened by dave
const DAVE_RESERVE = 20_000; // one extra allocation for just-in-time liquidity (B9)
const CAPACITY_SAT = 1_000_000;
const CHANNEL_UTXO_SAT = 1_100_000; // capacity + fees, from spike 2
const READY_TIMEOUT_MS = 180_000;

const t0 = Date.now();
const secrets: Secrets = { nodes: {}, treasuryMnemonic: newTreasuryMnemonic() };
saveSecrets(secrets);

// 1. nodes
const pubkey = {} as Record<Member, string>;
for (const m of MEMBERS) pubkey[m] = await initAndUnlock(m, secrets);

// 2. BTC for every node and the treasury
const treasury = await openTreasury(secrets.treasuryMnemonic!);
fund(await treasury.account.getAddress(), '1');
for (const m of MEMBERS) await fundNode(m, '1');
await mineAndSync(1);

// 3. colorable UTXOs
const made = await treasury.account.createUtxos({ upTo: false, num: 10, size: 32_000, feeRate: 2 });
log('treasury createUtxos', { made });
for (const m of MEMBERS) await createUtxos(m, 10);
// one big UTXO per channel the node opens, plus one spare (dave: B9's extra liquidity channel)
for (const m of MEMBERS)
  await createUtxos(m, m === 'dave' ? TRAVELLERS.length + 1 : 2, CHANNEL_UTXO_SAT);
await mineAndSync(1);

// 4. issue DUSD on the treasury (NIA, precision 2)
const asset = treasury.account.issueAssetNia({
  ticker: 'DUSD',
  name: 'Demo Dollar',
  precision: 2,
  amounts: [ISSUED],
});
const assetId: string = asset.assetId;
log('issued DUSD', { assetId, units: ISSUED });

// 5. on-ramp, one transfer at a time. Dave gets one allocation per channel he opens:
//    one DUSD allocation allows only one channel opening at a time (spike 2, trap 6).
const onrampTxids: { to: Member; amount: number; txid: string }[] = [];
const plan: [Member, number][] = [
  ...TRAVELLERS.map((m): [Member, number] => [m, ONRAMP]),
  ...TRAVELLERS.map((): [Member, number] => ['dave', L]),
  ['dave', DAVE_RESERVE],
];
for (const [to, amount] of plan)
  onrampTxids.push({ to, amount, txid: await onramp(treasury.account, assetId, to, amount) });
treasury.dispose();

// 6. peers and channels (ln-2ch: travel channel + liquidity channel per traveller)
const addr = (m: Member) => `${pubkey[m]}@rln-${m}:${PEER_PORT[m]}`;
const channelBody = (peer: Member, assetAmount: number) => ({
  peer_pubkey_and_opt_addr: addr(peer),
  capacity_sat: CAPACITY_SAT,
  push_msat: 0,
  asset_amount: assetAmount,
  asset_id: assetId,
  public: true,
  with_anchors: true,
  fee_base_msat: 0,
  fee_proportional_millionths: 0,
});

interface Channel {
  channel_id: string;
  funding_txid: string | null;
  peer_pubkey: string;
  status: string;
  ready: boolean;
  is_usable: boolean;
  capacity_sat: number;
  local_balance_sat: number;
  outbound_balance_msat: number;
  inbound_balance_msat: number;
  asset_id: string | null;
  asset_local_amount: number | null;
  asset_remote_amount: number | null;
}
const listChannels = async (m: Member) =>
  (await rln<{ channels: Channel[] }>(m, '/listchannels')).channels;

async function requestOpen(from: Member, peer: Member, assetAmount: number): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      await rln(from, '/openchannel', channelBody(peer, assetAmount));
      return;
    } catch (e) {
      if (!(e instanceof RlnError) || attempt >= 3) throw e;
      log('openchannel retry', { from, peer, attempt, error: e.message });
      await mineAndSync(1);
    }
  }
}

/**
 * Opens one channel and waits until its funding tx is on esplora, then confirms it with one
 * block. Opens run one at a time: back-to-back opens from dave's node spent the same inputs
 * (bad-txns-inputs-missingorspent), and a peer once rejected an open on a transient indexer
 * miss. A channel that vanishes or never gets funded is opened again, up to 3 times.
 */
async function openChannel(from: Member, peer: Member, assetAmount: number): Promise<string> {
  for (let attempt = 1; attempt <= 3; attempt++) {
    const before = new Set((await listChannels(from)).map((c) => c.channel_id));
    await requestOpen(from, peer, assetAmount);
    try {
      const txid = await waitFor(
        `funding tx of ${from} → ${peer}`,
        async () => {
          const ch = (await listChannels(from)).find(
            (c) => !before.has(c.channel_id) && c.peer_pubkey === pubkey[peer],
          );
          if (ch?.funding_txid && (await esploraHasTx(ch.funding_txid))) return ch.funding_txid;
          return false;
        },
        { timeoutMs: 60_000, everyMs: 1000 },
      );
      await mineAndSync(1);
      log('channel funded', { from, peer, assetAmount, fundingTxid: txid });
      return txid;
    } catch (e) {
      log('channel open failed, retrying', { from, peer, attempt, error: (e as Error).message });
      await mineAndSync(1);
    }
  }
  throw new Error(
    `could not open channel ${from} → ${peer} after 3 attempts (see docker logs kitty-rln-${from}-1)`,
  );
}

for (const m of TRAVELLERS) await rln(m, '/connectpeer', { peer_pubkey_and_addr: addr('dave') });
for (const m of TRAVELLERS) await openChannel(m, 'dave', D);
for (const m of TRAVELLERS) await openChannel('dave', m, L);

// 7. mine until all 6 channels are ready and usable
await mineAndSync(6);
await waitFor(
  '6 channels ready and usable',
  async () => {
    const daves = await listChannels('dave');
    const usable = daves.filter((c) => c.ready && c.is_usable && c.asset_id === assetId);
    if (usable.length === 6) return true;
    log('waiting for channels', { usable: usable.length, of: 6 });
    await mineAndSync(1);
    return false;
  },
  { timeoutMs: READY_TIMEOUT_MS, everyMs: 3000 },
);

// 8. balances: what every member should see now
for (const m of MEMBERS)
  await rln(m, '/refreshtransfers', { asset_id: null, filter: [], skip_sync: false });

// integer formatting, no floats: 309 -> "3.09"
const dusd = (units: number | null) => {
  const u = String(units ?? 0).padStart(3, '0');
  return `${u.slice(0, -2)}.${u.slice(-2)}`;
};
const report: Record<string, unknown> = {};
const problems: string[] = [];
console.log('\nExpected balances after the seed (DUSD, sats):');
for (const m of MEMBERS) {
  const bal = await assetBalance(m, assetId);
  const channels = (await listChannels(m)).map((c) => {
    const kind =
      m === 'dave'
        ? (c.asset_local_amount ?? 0) > 0
          ? 'liquidity'
          : 'travel'
        : (c.asset_local_amount ?? 0) > 0
          ? 'travel'
          : 'liquidity';
    const peer = MEMBERS.find((x) => pubkey[x] === c.peer_pubkey) ?? c.peer_pubkey;
    return {
      kind,
      peer,
      channelId: c.channel_id,
      fundingTxid: c.funding_txid,
      dusdLocal: c.asset_local_amount ?? 0,
      dusdRemote: c.asset_remote_amount ?? 0,
      satLocal: c.local_balance_sat,
      satRemote: c.capacity_sat - c.local_balance_sat,
      outboundMsat: c.outbound_balance_msat,
      inboundMsat: c.inbound_balance_msat,
      usable: c.ready && c.is_usable,
    };
  });
  report[m] = { pubkey: pubkey[m], onchain: bal, channels };
  console.log(
    `  ${m.padEnd(8)} on-chain ${dusd(bal.settled)} settled, off-chain out ${dusd(bal.offchain_outbound)} in ${dusd(bal.offchain_inbound)}`,
  );
  for (const c of channels)
    console.log(
      `           ${c.kind.padEnd(9)} with ${String(c.peer).padEnd(7)} DUSD local ${dusd(c.dusdLocal)} remote ${dusd(c.dusdRemote)}  sat local ${c.satLocal} remote ${c.satRemote}${c.usable ? '' : '  NOT USABLE'}`,
    );

  // checks against SPEC §15
  const wantOnchain = m === 'dave' ? DAVE_RESERVE : ONRAMP - D;
  if (bal.settled !== wantOnchain) problems.push(`${m} on-chain ${bal.settled} != ${wantOnchain}`);
  const wantChannels = m === 'dave' ? 6 : 2;
  if (channels.filter((c) => c.usable).length !== wantChannels)
    problems.push(
      `${m} has ${channels.filter((c) => c.usable).length} usable channels, want ${wantChannels}`,
    );
  if (m !== 'dave') {
    const travel = channels.find((c) => c.kind === 'travel');
    const liq = channels.find((c) => c.kind === 'liquidity');
    if (travel?.dusdLocal !== D || travel?.dusdRemote !== 0)
      problems.push(`${m} travel channel != ${D}/0`);
    if (liq?.dusdLocal !== 0 || liq?.dusdRemote !== L)
      problems.push(`${m} liquidity channel != 0/${L}`);
  }
}

// 9. test vector for the relay's BOLT11 decoder (stream C): invoice by alice, decoded by dave
const invoiceRequest = {
  amt_msat: 3_000_000,
  expiry_sec: 3600,
  asset_id: assetId,
  asset_amount: 309,
  description: 'kitty:test:1:alice',
};
const { invoice } = await rln<{ invoice: string }>('alice', '/lninvoice', invoiceRequest);
const decoded = await rln('dave', '/decodelninvoice', { invoice });
const vectorFile = writeOut('decode-vector.json', {
  note: 'regtest only; regenerated by every demo:reset',
  createdBy: 'alice',
  decodedBy: 'dave',
  payeeNodePubkey: pubkey.alice,
  request: invoiceRequest,
  invoice,
  decoded,
});

// 10. non-secret state for the wallet and the agent (B3)
const stateFile = writeOut('seed-state.json', {
  createdAt: new Date().toISOString(),
  assetId,
  pubkeys: pubkey,
  onramp: onrampTxids,
  members: report,
});

if (problems.length) {
  console.error('\nSEED FAILED CHECKS:\n  ' + problems.join('\n  '));
  process.exit(1);
}
console.log(`\nseed done in ${Math.round((Date.now() - t0) / 1000)} s, asset ${assetId}`);
console.log(`decode vector: ${vectorFile}`);
console.log(`seed state:    ${stateFile}`);
process.exit(0);
