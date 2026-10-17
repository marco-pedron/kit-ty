// Stage 1: RGB HODL invoices on the fork, over REST only.
// dave issues a NIA, opens ONE channel to alice with D + L on his side (push_msat for alice's
// future payments), then: HODL invoice by alice with her own hash → dave pays → Claimable →
// /claimhodlinvoice → dave reads the preimage from /getpayment. Then the cancel and the expiry.
// Run on a fresh stack: scripts/stack.sh reset && scripts/stack.sh up && npm run stage1
import {
  assetBalance,
  channels,
  ensureMiner,
  fundNode,
  get,
  height,
  log,
  mine,
  peerAddr,
  post,
  preimageAndHash,
  RlnError,
  setupNode,
  sha256hex,
  sleep,
  waitFor,
  type Member,
  type S,
} from './lib.ts';

const D = 5000; // traveler's trip budget, cents (50.00)
const L = 3000; // dave's liquidity, cents (30.00)
const CAPACITY_SAT = 1_000_000;
const PUSH_MSAT = 300_000_000; // 300k sat to alice: ~100 RGB payments at 3000 sat each
const HTLC_MSAT = 3_000_000; // rgb_htlc_min_msat (read and checked below)

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`ASSERTION FAILED: ${msg}`);
}

async function payment(m: Member, hash: string, type: S['PaymentType']): Promise<S['Payment'] | null> {
  try {
    return (await post(m, '/getpayment', { payment_hash: hash, payment_type: type })).payment;
  } catch (e) {
    if (e instanceof RlnError && e.status === 404) return null;
    throw e;
  }
}
async function waitPayment(m: Member, hash: string, type: S['PaymentType'], status: S['HTLCStatus'], timeoutMs = 60_000) {
  let last: S['Payment'] | null = null;
  await waitFor(`${m} ${type} ${hash.slice(0, 8)} → ${status}`, async () => {
    last = await payment(m, hash, type);
    return last?.status === status;
  }, timeoutMs);
  return last as unknown as S['Payment'];
}
const chanView = (c: S['Channel']) => ({
  asset_local: c.asset_local_amount,
  asset_remote: c.asset_remote_amount,
  local_sat: c.local_balance_sat,
  outbound_msat: c.outbound_balance_msat,
  usable: c.is_usable,
});
async function theChannel(m: Member, peer: string) {
  const cs = (await channels(m)).filter((c) => c.peer_pubkey === peer);
  assert(cs.length === 1, `${m} has ${cs.length} channels with the peer, expected 1`);
  return cs[0];
}

await ensureMiner();
const davePk = await setupNode('dave');
const alicePk = await setupNode('alice');
log('nodes unlocked', { dave: davePk, alice: alicePk });
const info = await get('dave', '/nodeinfo');
assert(info.rgb_htlc_min_msat === HTLC_MSAT, `rgb_htlc_min_msat is ${info.rgb_htlc_min_msat}`);

await fundNode('dave', 1, 5, 1_100_000);
await fundNode('alice', 0.1, 2, 100_000);
const { asset } = await post('dave', '/issueassetnia', { amounts: [1_000_000], ticker: 'DUSD', name: 'Demo USD', precision: 2 });
const assetId = asset.asset_id;
log('DUSD issued on dave', { assetId, balance: await assetBalance('dave', assetId) });

// ---- ONE channel dave → alice with D + L on dave's side, push_msat for alice
const h0 = await height();
const open = await post('dave', '/openchannel', {
  peer_pubkey_and_opt_addr: `${alicePk}@${peerAddr('alice')}`,
  capacity_sat: CAPACITY_SAT,
  push_msat: PUSH_MSAT,
  asset_amount: D + L,
  asset_id: assetId,
  public: true,
  with_anchors: true,
  fee_base_msat: 0,
  fee_proportional_millionths: 0,
});
log('openchannel', { temporary_channel_id: open.temporary_channel_id });
await waitFor('funding tx in mempool', async () => (await channels('dave')).some((c) => c.funding_txid), 60_000, 500);
let blocks = 0;
for (; blocks < 12; ) {
  await mine(1);
  blocks++;
  await sleep(1500);
  const [d, a] = await Promise.all([channels('dave'), channels('alice')]);
  if (d.some((c) => c.is_usable && c.ready) && a.some((c) => c.is_usable && c.ready)) break;
}
const daveCh0 = await theChannel('dave', alicePk);
const aliceCh0 = await theChannel('alice', davePk);
assert(daveCh0.is_usable && aliceCh0.is_usable, 'channel not usable after 12 blocks');
log('channel usable', { blocks, heightFrom: h0, dave: chanView(daveCh0), alice: chanView(aliceCh0) });
assert(daveCh0.asset_local_amount === D + L && aliceCh0.asset_local_amount === 0, 'D + L all on dave side');

// ---- 1. HODL success: alice picks P, H; dave pays; Claimable; alice claims; dave learns P
{
  const { preimage, hash } = preimageAndHash();
  const { invoice } = await post('alice', '/lninvoice', {
    amt_msat: HTLC_MSAT,
    expiry_sec: 900,
    asset_id: assetId,
    asset_amount: D,
    payment_hash: hash,
  });
  const decoded = await post('dave', '/decodelninvoice', { invoice });
  assert(decoded.payment_hash === hash && decoded.payee_pubkey === alicePk, 'decoded invoice');
  log('HODL invoice', { hash, min_final_cltv_expiry_delta: decoded.min_final_cltv_expiry_delta, expiry_sec: decoded.expiry_sec, asset_amount: decoded.asset_amount });
  try {
    await post('alice', '/lninvoice', { amt_msat: HTLC_MSAT, expiry_sec: 60, payment_hash: hash });
    assert(false, 'duplicate hash accepted');
  } catch (e) {
    assert(e instanceof RlnError && e.rlnName === 'PaymentHashAlreadyUsed', `duplicate hash: ${e}`);
  }
  const hPay = await height();
  const t = Date.now();
  const sent = await post('dave', '/sendpayment', { invoice });
  log('dave /sendpayment', { status: sent.status });
  const held = await waitPayment('alice', hash, 'InboundHodl', 'Claimable');
  const tClaimable = Date.now() - t;
  const st = await post('alice', '/invoicestatus', { invoice });
  const daveSide = await payment('dave', hash, 'Outbound');
  log('held on alice', { ms: tClaimable, alice: held.status, invoicestatus: st.status, dave: daveSide?.status, daveHasPreimage: Boolean(daveSide?.preimage), dave_channel: chanView(await theChannel('dave', alicePk)) });
  assert(st.status === 'Claimable' && daveSide?.status === 'Pending' && !daveSide.preimage, 'held state');
  try {
    await post('alice', '/claimhodlinvoice', { payment_hash: hash, payment_preimage: preimageAndHash().preimage });
    assert(false, 'wrong preimage accepted');
  } catch (e) {
    assert(e instanceof RlnError && e.rlnName === 'InvalidPaymentPreimage', `wrong preimage: ${e}`);
  }
  const tc = Date.now();
  await post('alice', '/claimhodlinvoice', { payment_hash: hash, payment_preimage: preimage });
  const out = await waitPayment('dave', hash, 'Outbound', 'Succeeded');
  log('claimed', { claimToDaveSucceededMs: Date.now() - tc, totalMs: Date.now() - t, blocksMined: (await height()) - hPay });
  assert(out.preimage === preimage && sha256hex(out.preimage) === hash, 'dave learns P from /getpayment');
  const inb = await waitPayment('alice', hash, 'InboundHodl', 'Succeeded');
  log('preimage verified', { davePreimage: out.preimage, sha256OK: sha256hex(out.preimage) === hash, alice: inb.status });
  const d = await theChannel('dave', alicePk);
  const a = await theChannel('alice', davePk);
  log('channel after D moved', { dave: chanView(d), alice: chanView(a), aliceBalance: await assetBalance('alice', assetId) });
  assert(d.asset_local_amount === L && a.asset_local_amount === D, 'D on alice side, L on dave side');
}

// ---- 2. HODL cancel: Claimable → /cancelhodlinvoice → dave's payment fails, nothing moves
{
  const before = chanView(await theChannel('dave', alicePk));
  const { hash } = preimageAndHash();
  const { invoice } = await post('alice', '/lninvoice', { amt_msat: HTLC_MSAT, expiry_sec: 900, asset_id: assetId, asset_amount: 100, payment_hash: hash });
  await post('dave', '/sendpayment', { invoice });
  await waitPayment('alice', hash, 'InboundHodl', 'Claimable');
  const t = Date.now();
  await post('alice', '/cancelhodlinvoice', { payment_hash: hash });
  const out = await waitPayment('dave', hash, 'Outbound', 'Failed');
  const inb = await payment('alice', hash, 'InboundHodl');
  const st = await post('alice', '/invoicestatus', { invoice });
  await sleep(1000);
  const after = chanView(await theChannel('dave', alicePk));
  log('cancelled', { ms: Date.now() - t, dave: out.status, alice: inb?.status, invoicestatus: st.status, before, after });
  assert(after.asset_local === before.asset_local && after.local_sat === before.local_sat, 'cancel moves nothing');
}

// ---- 3. HODL expiry by blocks: never claimed → failed back at the claim deadline height
{
  const before = chanView(await theChannel('dave', alicePk));
  const { preimage, hash } = preimageAndHash();
  const { invoice } = await post('alice', '/lninvoice', { amt_msat: HTLC_MSAT, expiry_sec: 900, asset_id: assetId, asset_amount: 100, payment_hash: hash });
  const hStart = await height();
  await post('dave', '/sendpayment', { invoice });
  await waitPayment('alice', hash, 'InboundHodl', 'Claimable');
  let n = 0;
  for (; n < 300; n++) {
    const p = await payment('alice', hash, 'InboundHodl');
    if (p?.status === 'Failed') break;
    await mine(1);
    await sleep(300);
  }
  const out = await waitPayment('dave', hash, 'Outbound', 'Failed', 90_000);
  let claimAfter = '';
  try {
    await post('alice', '/claimhodlinvoice', { payment_hash: hash, payment_preimage: preimage });
  } catch (e) {
    claimAfter = e instanceof RlnError ? `${e.status} ${e.rlnName}` : String(e);
  }
  await sleep(1000);
  const after = chanView(await theChannel('dave', alicePk));
  log('expired by blocks', { blocksUntilFailed: n, heightAtPay: hStart, heightAtFail: await height(), dave: out.status, claimAfter, before, after });
  assert(claimAfter !== '' && after.asset_local === before.asset_local, 'expired HTLC returned to dave');
}

// ---- 4. HODL expiry by time: invoice expired before the payment → failed, nothing held
{
  const { hash } = preimageAndHash();
  const { invoice } = await post('alice', '/lninvoice', { amt_msat: HTLC_MSAT, expiry_sec: 5, asset_id: assetId, asset_amount: 100, payment_hash: hash });
  await sleep(7000);
  let res: string;
  try {
    res = (await post('dave', '/sendpayment', { invoice })).status;
  } catch (e) {
    res = e instanceof RlnError ? `${e.status} ${e.rlnName}` : String(e);
  }
  const st = await post('alice', '/invoicestatus', { invoice });
  log('expired by time', { sendpayment: res, invoicestatus: st.status, alice: (await payment('alice', hash, 'InboundHodl'))?.status ?? null });
}

const final = { dave: chanView(await theChannel('dave', alicePk)), alice: chanView(await theChannel('alice', davePk)) };
log('STAGE 1 OK', final);
