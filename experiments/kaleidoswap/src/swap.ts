// The atomic swap "D on-chain (traveler) ↔ D on the traveler's side of the channel (dave)".
//   traveler: P, H = sha256(P), refund key → locks D on-chain in HTLC(H, dave, traveler, T)
//             → HODL invoice (H, D) → after dave pays: /claimhodlinvoice (reveals P to dave)
//   dave:     claim key, T → verifySwap (all checks) → pays → watcher: P from /getpayment →
//             claims the HTLC on-chain before T
// Each side keeps its own state on disk (run/swaps/<who>/<id>.json): dave's watcher must survive
// a restart (case 9).
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { htlcInfo, lockFromRln, rlnRgbInvoice, tool, voutOf, type HtlcTerms } from './htlc.ts';
import { assetBalance, height, mine, post, preimageAndHash, rawTx, refresh, RlnError, waitFor, type Member, type S } from './lib.ts';
import { lnDeadlineBound, verifySwap, type SwapExpectation, type SwapVerdict } from './swap-verify.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const FINAL_CLTV_DELTA = 42; // requested (LDK MIN_FINAL_CLTV_EXPIRY_DELTA); the node writes 45
export const FINAL_CLTV_RANGE = [42, 48] as const; // dave accepts the invoice's delta only in here
export const MAX_SHADOW_CLTV = 3 * 144; // LDK MAX_SHADOW_CLTV_EXPIRY_DELTA_OFFSET: worst case, any graph
export const MARGIN_BLOCKS = 72;
export const T_DELTA = 600; // ≥ 1 + 48 + 432 + 72 = 553 after the payment, plus the lock and verify blocks
const HTLC_MSAT = 3_000_000;

// ---------- persistence ----------

function store(who: string) {
  const dir = join(ROOT, 'run', 'swaps', who);
  mkdirSync(dir, { recursive: true });
  return {
    save: (id: string, rec: object) => writeFileSync(join(dir, `${id}.json`), JSON.stringify(rec, null, 2), { mode: 0o600 }),
    load: <T>(id: string): T => JSON.parse(readFileSync(join(dir, `${id}.json`), 'utf8')),
    all: <T>(): T[] => (existsSync(dir) ? readdirSync(dir).map((f) => JSON.parse(readFileSync(join(dir, f), 'utf8'))) : []),
  };
}

export interface TravelerSwap {
  id: string;
  traveler: Member;
  amount: number;
  preimage: string;
  hash: string;
  refundSecret: string;
  refundKey: string;
  terms?: HtlcTerms;
  lock?: { txid: string; outpoint: string; recipientId: string; blinding: number; amount: number };
  invoice?: string;
  state: 'proposed' | 'locked' | 'invoiced' | 'claimed_ln' | 'refunded';
}
export interface DaveSwap {
  id: string;
  traveler: Member;
  travelerNodePubkey: string;
  amount: number;
  claimSecret: string;
  claimKey: string;
  refundKey: string;
  timeout: number;
  hash?: string;
  outpoint?: string;
  recipientId?: string;
  verdict?: SwapVerdict;
  payHeight?: number;
  state: 'offered' | 'refused' | 'paid' | 'ln_failed' | 'claimed_onchain';
  preimage?: string;
  claimTxid?: string;
  claimHeight?: number;
}
const travelerStore = (m: Member) => store(m);
const daveStore = store('dave');

// ---------- traveler side ----------

export function travelerPropose(id: string, traveler: Member, amount: number): TravelerSwap {
  const { preimage, hash } = preimageAndHash();
  const k = tool('keygen');
  const s: TravelerSwap = { id, traveler, amount, preimage, hash, refundSecret: k.secret, refundKey: k.xonly, state: 'proposed' };
  travelerStore(traveler).save(id, s);
  return s;
}

/** Locks `lockAmount` (normally D) in the HTLC with `terms` from the traveler's RLN node, waits 1
 *  confirmation, and imports the lock in the traveler's rgb-lib wallet (needed for a refund). */
export async function travelerLock(s: TravelerSwap, terms: HtlcTerms, lockAmount = s.amount): Promise<TravelerSwap> {
  const info = htlcInfo(terms);
  const blinding = 1000 + Math.floor(Math.random() * 1e6);
  const txid = await lockFromRln(s.traveler, { assetId: assetIdOf(), amount: lockAmount, recipientId: info.recipient_id, blinding });
  await mine(1);
  const outpoint = `${txid}:${await voutOf(txid, info.script_pubkey)}`;
  await refresh(s.traveler);
  tool('accept', { wallet: `${s.traveler}-htlc`, 'recipient-id': info.recipient_id, blinding, amount: lockAmount, 'asset-id': assetIdOf(), 'lock-txid': txid, outpoint });
  s.terms = terms;
  s.lock = { txid, outpoint, recipientId: info.recipient_id, blinding, amount: lockAmount };
  s.state = 'locked';
  travelerStore(s.traveler).save(s.id, s);
  return s;
}

export async function travelerInvoice(s: TravelerSwap, hash = s.hash): Promise<string> {
  const { invoice } = await post(s.traveler, '/lninvoice', {
    amt_msat: HTLC_MSAT,
    expiry_sec: 3600,
    asset_id: assetIdOf(),
    asset_amount: s.amount,
    payment_hash: hash,
    min_final_cltv_expiry_delta: FINAL_CLTV_DELTA,
  });
  s.invoice = invoice;
  s.state = 'invoiced';
  travelerStore(s.traveler).save(s.id, s);
  return invoice;
}

export async function travelerClaimLn(s: TravelerSwap): Promise<void> {
  await post(s.traveler, '/claimhodlinvoice', { payment_hash: s.hash, payment_preimage: s.preimage });
  await waitFor('traveler HODL succeeded', async () => (await getPayment(s.traveler, s.hash, 'InboundHodl'))?.status === 'Succeeded', 60_000);
  s.state = 'claimed_ln';
  travelerStore(s.traveler).save(s.id, s);
}

/** cltv_expiry of the held HTLC, from the traveler's own node log (LDK TRACE UpdateAddHTLC). */
export function heldHtlcCltvExpiry(m: Member, hash: string): number {
  const out = execFileSync('docker', ['exec', `kitty-kaleido-rln-${m}-1`, 'grep', '-ho', `payment_hash: ${hash}, cltv_expiry: [0-9]*`, '/RLNdata/.ldk/logs/logs.txt'], { encoding: 'utf8' });
  const n = Number(out.trim().split('\n').pop()!.split('cltv_expiry: ')[1]);
  if (!Number.isFinite(n)) throw new Error(`no cltv_expiry for ${hash} in ${m}'s log`);
  return n;
}

/** After T: spends the refund leaf into the traveler's rgb-lib wallet, then sends it back to the
 *  traveler's RLN node. */
export async function travelerRefund(s: TravelerSwap): Promise<{ refundTxid: string; backTxid: string }> {
  const { terms, lock } = s;
  if (!terms || !lock) throw new Error('nothing locked');
  while ((await height()) < terms.timeout) await mine(Math.min(50, terms.timeout - (await height())));
  const w = `${s.traveler}-htlc`;
  const refund = tool('spend', { wallet: w, path: 'refund', ...terms, secret: s.refundSecret, outpoint: lock.outpoint, 'asset-id': assetIdOf(), amount: lock.amount });
  const r = await broadcast(refund.tx_hex);
  if (!r.ok) throw new Error(`refund rejected: ${r.error}`);
  await mine(1);
  tool('apply', { wallet: w, op: refund.operation_id, 'asset-id': assetIdOf() });
  await mine(1);
  const before = (await assetBalance(s.traveler, assetIdOf())).settled;
  const rid = await rlnRgbInvoice(s.traveler, assetIdOf(), lock.amount);
  const sent = tool('send', { wallet: w, 'asset-id': assetIdOf(), amount: lock.amount, 'recipient-id': rid });
  await mine(1);
  await waitFor(`${s.traveler} refund back on RLN`, async () => (await refresh(s.traveler), (await assetBalance(s.traveler, assetIdOf())).settled === before + lock.amount), 90_000, 2000);
  s.state = 'refunded';
  travelerStore(s.traveler).save(s.id, s);
  return { refundTxid: refund.txid, backTxid: sent.txid };
}

// ---------- dave side ----------

export async function daveOffer(id: string, traveler: Member, travelerNodePubkey: string, refundKey: string, amount: number, tDelta = T_DELTA): Promise<DaveSwap> {
  const k = tool('keygen');
  const d: DaveSwap = { id, traveler, travelerNodePubkey, amount, claimSecret: k.secret, claimKey: k.xonly, refundKey, timeout: (await height()) + tDelta, state: 'offered' };
  daveStore.save(id, d);
  return d;
}

/** Gathers what dave observed and runs verifySwap. `announced` and the outpoint come from the
 *  traveler; everything else dave computes or checks himself. */
export async function daveVerify(d: DaveSwap, p: { invoice: string; announced: HtlcTerms; outpoint: string; blinding: number }): Promise<SwapVerdict> {
  const dec = await post('dave', '/decodelninvoice', { invoice: p.invoice });
  const expected = htlcInfo({ hash: dec.payment_hash, claim: d.claimKey, refund: d.refundKey, timeout: d.timeout });
  const [txid, vout] = p.outpoint.split(':');
  let lockOutput: { scriptPubkey: string; valueSat: number; confirmations: number } | null = null;
  try {
    const tx = (await rawTx(txid)) as unknown as { confirmations?: number; vout: { n: number; value: number; scriptPubKey: { hex: string } }[] };
    const o = tx.vout.find((v) => v.n === Number(vout));
    if (o) lockOutput = { scriptPubkey: o.scriptPubKey.hex, valueSat: Math.round(o.value * 1e8), confirmations: tx.confirmations ?? 0 };
  } catch {
    lockOutput = null;
  }
  // dave's wallet fetches the consignment under the recipient id of the script HE expects, and
  // validates it for (asset, D): a lock on any other script is simply not found
  let consignment: { accepted: true; assetId: string; amount: number } | { accepted: false; error: string };
  if (!lockOutput || lockOutput.confirmations < 1) consignment = { accepted: false, error: 'lock not confirmed: not fetched' };
  else
    try {
      tool('accept', { wallet: 'dave-htlc', 'recipient-id': expected.recipient_id, blinding: p.blinding, amount: d.amount, 'asset-id': assetIdOf(), 'lock-txid': txid, outpoint: p.outpoint });
      consignment = { accepted: true, assetId: assetIdOf(), amount: d.amount };
    } catch (e) {
      consignment = { accepted: false, error: String((e as Error).message).slice(0, 200) };
    }
  const x: SwapExpectation = {
    assetId: assetIdOf(),
    amount: d.amount,
    travelerNodePubkey: d.travelerNodePubkey,
    travelerRefundKey: d.refundKey,
    daveClaimKey: d.claimKey,
    timeout: d.timeout,
    minFinalCltvDelta: FINAL_CLTV_RANGE[0],
    maxFinalCltvDelta: FINAL_CLTV_RANGE[1],
    maxShadowCltv: MAX_SHADOW_CLTV,
    marginBlocks: MARGIN_BLOCKS,
  };
  const verdict = verifySwap(x, {
    currentHeight: await height(),
    invoice: {
      paymentHash: dec.payment_hash,
      assetId: dec.asset_id ?? null,
      assetAmount: dec.asset_amount ?? null,
      payeePubkey: dec.payee_pubkey ?? "",
      minFinalCltvExpiryDelta: dec.min_final_cltv_expiry_delta,
      expiresAt: dec.timestamp + dec.expiry_sec,
    },
    announced: p.announced,
    expected: { scriptPubkey: expected.script_pubkey, internalKey: (expected as unknown as { internal_key: string }).internal_key },
    lockOutput,
    consignment,
    nowSec: Math.floor(Date.now() / 1000),
  });
  d.hash = dec.payment_hash;
  d.outpoint = p.outpoint;
  d.recipientId = expected.recipient_id;
  d.verdict = verdict;
  if (!verdict.pay) d.state = 'refused';
  daveStore.save(d.id, d);
  return verdict;
}

/** Pays only after a passing verdict; the record is saved as `paid` before the payment. */
export async function davePay(d: DaveSwap, invoice: string): Promise<void> {
  if (!d.verdict?.pay) throw new Error(`dave refuses to pay: ${d.verdict?.failures.join('; ')}`);
  d.state = 'paid';
  d.payHeight = await height();
  daveStore.save(d.id, d);
  await post('dave', '/sendpayment', { invoice });
}

/** dave's watcher, one pass over the persisted swaps: P from /getpayment (payment_type
 *  Outbound) → on-chain claim. Returns what it did. Survives restarts: state is on disk. */
export async function daveWatcherTick(): Promise<string[]> {
  const did: string[] = [];
  for (const d of daveStore.all<DaveSwap>().filter((x) => x.state === 'paid')) {
    const p = await getPayment('dave', d.hash!, 'Outbound');
    if (p?.status === 'Failed') {
      d.state = 'ln_failed';
      daveStore.save(d.id, d);
      did.push(`${d.id}: LN payment failed back, nothing to claim`);
      continue;
    }
    if (p?.status !== 'Succeeded' || !p.preimage) continue;
    d.preimage = p.preimage;
    const spend = tool('spend', {
      wallet: 'dave-htlc', path: 'claim', hash: d.hash!, claim: d.claimKey, refund: d.refundKey, timeout: d.timeout,
      secret: d.claimSecret, preimage: p.preimage, outpoint: d.outpoint!, 'asset-id': assetIdOf(), amount: d.amount,
    });
    const r = await broadcast(spend.tx_hex);
    if (!r.ok) {
      tool('abort', { wallet: 'dave-htlc', op: spend.operation_id });
      did.push(`${d.id}: claim rejected: ${r.error}`);
      continue;
    }
    await mine(1);
    tool('apply', { wallet: 'dave-htlc', op: spend.operation_id, 'asset-id': assetIdOf() });
    d.state = 'claimed_onchain';
    d.claimTxid = spend.txid;
    d.claimHeight = await height();
    daveStore.save(d.id, d);
    did.push(`${d.id}: claimed on-chain ${spend.txid} at ${d.claimHeight} (T ${d.timeout})`);
  }
  return did;
}
export const daveRecord = (id: string) => daveStore.load<DaveSwap>(id);

// ---------- helpers ----------

let ASSET_ID = '';
export const setAssetId = (id: string) => (ASSET_ID = id);
export const assetIdOf = () => ASSET_ID;
export { lnDeadlineBound };

export async function getPayment(m: Member, hash: string, type: S['PaymentType']): Promise<S['Payment'] | null> {
  try {
    return (await post(m, '/getpayment', { payment_hash: hash, payment_type: type })).payment;
  } catch (e) {
    if (e instanceof RlnError && e.status === 404) return null;
    throw e;
  }
}
export async function broadcast(hex: string): Promise<{ ok: true; txid: string } | { ok: false; error: string }> {
  const res = await fetch(process.env.KK_BITCOIND_URL ?? 'http://127.0.0.1:28443', {
    method: 'POST',
    headers: { authorization: 'Basic ' + Buffer.from('user:password').toString('base64') },
    body: JSON.stringify({ jsonrpc: '1.0', id: 'kk', method: 'sendrawtransaction', params: [hex] }),
  });
  const j = (await res.json()) as { result: string; error: { message: string } | null };
  return j.error ? { ok: false, error: j.error.message } : { ok: true, txid: j.result };
}
