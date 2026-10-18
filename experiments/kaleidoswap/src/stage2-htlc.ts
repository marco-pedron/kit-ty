// Stage 2: RGB HTLC on-chain with assets born on RLN (the fork), spent with the rgb-lib fork.
// Runs after stage 1 on the same stack (dave holds the DUSD issued there).
//   0. on-ramp: dave's RLN node sends DUSD on-chain to alice's RLN node
//   a. alice's RLN node locks DUSD in the HTLC (/sendrgb, witness recipient); dave's rgb-lib
//      wallet accepts and validates the lock; a claim with a wrong preimage is rejected; the
//      claim with P confirms; the DUSD go on to dave's RLN node
//   b. alice locks again; her rgb-lib wallet accepts the lock; the refund is rejected before the
//      timeout and confirmed after it; the DUSD go back to alice's RLN node
import { htlcInfo, lockFromRln, rlnRgbInvoice, rlnSend, tool, voutOf, type HtlcTerms } from './htlc.ts';
import { assetBalance, height, log, mine, mempool, post, preimageAndHash, refresh, sendBtc, waitFor } from './lib.ts';

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`ASSERTION FAILED: ${msg}`);
}
async function broadcast(hex: string): Promise<{ ok: true; txid: string } | { ok: false; error: string }> {
  try {
    const res = await fetch(process.env.KK_BITCOIND_URL ?? 'http://127.0.0.1:28443', {
      method: 'POST',
      headers: { authorization: 'Basic ' + Buffer.from('user:password').toString('base64') },
      body: JSON.stringify({ jsonrpc: '1.0', id: 'kk', method: 'sendrawtransaction', params: [hex] }),
    });
    const j = (await res.json()) as { result: string; error: { message: string } | null };
    return j.error ? { ok: false, error: j.error.message } : { ok: true, txid: j.result };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}
async function fundToolWallet(wallet: string): Promise<void> {
  const { address } = tool('address', { wallet });
  await sendBtc(address, 0.01);
  await mine(1);
}
const settled = async (m: 'alice' | 'dave', assetId: string) => (await assetBalance(m, assetId)).settled;

// the asset issued in stage 1
const assets = await post('dave', '/listassets', { filter_asset_schemas: ['Nia'] });
const assetId = assets.nia![0].asset_id;
log('asset', { assetId, dave: await assetBalance('dave', assetId) });

// 0. on-ramp RLN → RLN
if ((await settled('alice', assetId)) < 10_000) {
  const txid = await rlnSend('dave', 'alice', assetId, 10_000);
  await waitFor('alice settled', async () => (await refresh('alice'), (await settled('alice', assetId)) >= 10_000), 60_000, 1000);
  log('on-ramp dave → alice on-chain', { txid, alice: await assetBalance('alice', assetId) });
}

const daveKey = tool('keygen');
const aliceKey = tool('keygen');
await fundToolWallet('dave-htlc');
await fundToolWallet('alice-htlc');

// ---------- a. lock from RLN, claim with P ----------
{
  const LOCK = 5000;
  const BLINDING = 4242;
  const { preimage, hash } = preimageAndHash();
  const terms: HtlcTerms = { hash, claim: daveKey.xonly, refund: aliceKey.xonly, timeout: (await height()) + 200 };
  const info = htlcInfo(terms);
  const aliceBefore = await settled('alice', assetId);
  const t = Date.now();
  const lockTxid = await lockFromRln('alice', { assetId, amount: LOCK, recipientId: info.recipient_id, blinding: BLINDING });
  await mine(1);
  const vout = await voutOf(lockTxid, info.script_pubkey);
  const outpoint = `${lockTxid}:${vout}`;
  await refresh('alice');
  log('a. locked from alice RLN', { lockTxid, outpoint, recipient_id: info.recipient_id, timeout: terms.timeout, aliceSettled: `${aliceBefore} → ${await settled('alice', assetId)}`, ms: Date.now() - t });

  const accepted = tool('accept', { wallet: 'dave-htlc', 'recipient-id': info.recipient_id, blinding: BLINDING, amount: LOCK, 'asset-id': assetId, 'lock-txid': lockTxid, outpoint });
  log('a. dave accepted and validated the lock (rgb-lib fork ← RLN consignment)', accepted);

  // a wrong preimage: the node rejects the transaction
  const wrong = tool('spend', { wallet: 'dave-htlc', path: 'claim', ...terms, secret: daveKey.secret, preimage: preimageAndHash().preimage, outpoint, 'asset-id': assetId, amount: LOCK, 'no-mark': true });
  const wrongRes = await broadcast(wrong.tx_hex);
  tool('abort', { wallet: 'dave-htlc', op: wrong.operation_id });
  log('a. claim with a wrong preimage', { broadcast: wrongRes });
  assert(!wrongRes.ok, 'wrong preimage accepted');

  const tc = Date.now();
  const claim = tool('spend', { wallet: 'dave-htlc', path: 'claim', ...terms, secret: daveKey.secret, preimage, outpoint, 'asset-id': assetId, amount: LOCK });
  const claimRes = await broadcast(claim.tx_hex);
  assert(claimRes.ok, `claim rejected: ${JSON.stringify(claimRes)}`);
  await mine(1);
  tool('apply', { wallet: 'dave-htlc', op: claim.operation_id, 'asset-id': assetId });
  await mine(1);
  const bal = tool('balance', { wallet: 'dave-htlc', 'asset-id': assetId });
  log('a. claimed with P', { claimTxid: claim.txid, allocations: claim.allocations, daveHtlcWallet: bal.asset, ms: Date.now() - tc });
  assert(bal.asset.settled === LOCK, 'claimed amount settled in dave-htlc');

  // onward to dave's RLN node (rgb-lib fork → RLN consignment)
  const daveBefore = await settled('dave', assetId);
  const rid = await rlnRgbInvoice('dave', assetId, LOCK);
  const sent = tool('send', { wallet: 'dave-htlc', 'asset-id': assetId, amount: LOCK, 'recipient-id': rid });
  await mine(1);
  await waitFor('dave RLN settled', async () => (await refresh('dave'), (await settled('dave', assetId)) === daveBefore + LOCK), 90_000, 2000);
  log('a. sent on to dave RLN', { txid: sent.txid, daveSettled: `${daveBefore} → ${await settled('dave', assetId)}` });
}

// ---------- b. lock from RLN, refund after the timeout ----------
{
  const LOCK = 2000;
  const BLINDING = 4343;
  const { hash } = preimageAndHash();
  const DELTA = 15;
  const terms: HtlcTerms = { hash, claim: daveKey.xonly, refund: aliceKey.xonly, timeout: (await height()) + DELTA };
  const info = htlcInfo(terms);
  const aliceBefore = await settled('alice', assetId);
  const lockTxid = await lockFromRln('alice', { assetId, amount: LOCK, recipientId: info.recipient_id, blinding: BLINDING });
  await mine(1);
  const outpoint = `${lockTxid}:${await voutOf(lockTxid, info.script_pubkey)}`;
  await refresh('alice');
  log('b. locked from alice RLN', { lockTxid, timeout: terms.timeout, height: await height(), aliceSettled: `${aliceBefore} → ${await settled('alice', assetId)}` });

  // the locker's own rgb-lib wallet imports the lock it made from RLN
  tool('accept', { wallet: 'alice-htlc', 'recipient-id': info.recipient_id, blinding: BLINDING, amount: LOCK, 'asset-id': assetId, 'lock-txid': lockTxid, outpoint });

  const early = tool('spend', { wallet: 'alice-htlc', path: 'refund', ...terms, secret: aliceKey.secret, outpoint, 'asset-id': assetId, amount: LOCK, 'no-mark': true });
  const earlyRes = await broadcast(early.tx_hex);
  tool('abort', { wallet: 'alice-htlc', op: early.operation_id });
  log('b. refund before the timeout', { height: await height(), timeout: terms.timeout, lock_time: early.lock_time, broadcast: earlyRes });
  assert(!earlyRes.ok && earlyRes.error.includes('non-final'), 'early refund must be non-final');

  let mined = 0;
  while ((await height()) < terms.timeout) {
    await mine(1);
    mined++;
  }
  const refund = tool('spend', { wallet: 'alice-htlc', path: 'refund', ...terms, secret: aliceKey.secret, outpoint, 'asset-id': assetId, amount: LOCK });
  const refundRes = await broadcast(refund.tx_hex);
  assert(refundRes.ok, `refund rejected: ${JSON.stringify(refundRes)}`);
  await mine(1);
  tool('apply', { wallet: 'alice-htlc', op: refund.operation_id, 'asset-id': assetId });
  await mine(1);
  const bal = tool('balance', { wallet: 'alice-htlc', 'asset-id': assetId });
  log('b. refunded after the timeout', { minedToTimeout: mined, refundTxid: refund.txid, aliceHtlcWallet: bal.asset, mempool: (await mempool()).length });
  assert(bal.asset.settled === LOCK, 'refund settled in alice-htlc');

  const before = await settled('alice', assetId);
  const rid = await rlnRgbInvoice('alice', assetId, LOCK);
  const sent = tool('send', { wallet: 'alice-htlc', 'asset-id': assetId, amount: LOCK, 'recipient-id': rid });
  await mine(1);
  await waitFor('alice RLN settled', async () => (await refresh('alice'), (await settled('alice', assetId)) === before + LOCK), 90_000, 2000);
  log('b. sent back to alice RLN', { txid: sent.txid, aliceSettled: `${before} → ${await settled('alice', assetId)}` });
}

log('STAGE 2 OK', { alice: await assetBalance('alice', assetId), dave: await assetBalance('dave', assetId) });
