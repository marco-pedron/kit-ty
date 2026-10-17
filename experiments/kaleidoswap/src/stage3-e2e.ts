// Stage 3: one channel per traveler funded by an atomic swap, then the payments of the kitty
// model, then the failure cases. Fresh stack (run.sh). Prints one line per case and a table.
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { rlnSend, tool } from './htlc.ts';
import { assetBalance, channels, ensureMiner, fundNode, get, height, log, mine, mempool, peerAddr, post, refresh, sendBtc, setupNode, sha256hex, sleep, waitFor, type Member, type S } from './lib.ts';
import {
  broadcast, daveOffer, davePay, daveRecord, daveVerify, daveWatcherTick, getPayment, heldHtlcCltvExpiry, setAssetId,
  travelerClaimLn, travelerInvoice, travelerLock, travelerPropose, travelerRefund, MARGIN_BLOCKS, type TravelerSwap,
} from './swap.ts';
import { HTLC_FAIL_BACK_BUFFER } from './swap-verify.ts';

const D = 5000;
const L = 3000;
const CAPACITY_SAT = 1_000_000;
const PUSH_MSAT = 300_000_000;
const TRAVELERS: Member[] = ['alice', 'bob', 'charlie'];

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`ASSERTION FAILED: ${msg}`);
}
interface Row { case: string; ok: boolean; blocks: number; ms: number; sats: string; note: string }
const rows: Row[] = [];
async function runCase(name: string, fn: () => Promise<{ sats?: string; note: string }>): Promise<void> {
  const h0 = await height();
  const t = Date.now();
  try {
    const r = await fn();
    rows.push({ case: name, ok: true, blocks: (await height()) - h0, ms: Date.now() - t, sats: r.sats ?? '', note: r.note });
  } catch (e) {
    rows.push({ case: name, ok: false, blocks: (await height()) - h0, ms: Date.now() - t, sats: '', note: String((e as Error).message).slice(0, 300) });
  }
  const r = rows[rows.length - 1];
  log(`${r.ok ? 'PASS' : 'FAIL'} ${name}`, { blocks: r.blocks, ms: r.ms, sats: r.sats, note: r.note });
}

const pk = {} as Record<Member, string>;
const chan = async (m: Member, peer: Member) => (await channels(m)).find((c) => c.peer_pubkey === pk[peer])!;
const btc = async (m: Member) => {
  const b = await post(m, '/btcbalance', { skip_sync: false });
  return b.vanilla.settled + b.colored.settled;
};
const settled = async (m: Member) => (await assetBalance(m, assetId)).settled;
let assetId = '';

async function payInvoice(from: Member, invoice: string, hash: string): Promise<{ ms: number; payment: S['Payment'] }> {
  const t = Date.now();
  for (let attempt = 1; ; attempt++) {
    await post(from, '/sendpayment', { invoice });
    let last: S['Payment'] | null = null;
    await waitFor('payment settled', async () => ((last = await getPayment(from, hash, 'Outbound')), last?.status === 'Succeeded' || last?.status === 'Failed'), 60_000);
    if ((last as unknown as S['Payment']).status === 'Succeeded') return { ms: Date.now() - t, payment: last as unknown as S['Payment'] };
    if (attempt >= 3) throw new Error(`payment failed ${attempt} times`);
    await sleep(5000); // gossip of freshly announced channels
  }
}

/** The swap for D on the traveler's side; `opts` drive the special cases. */
async function swap(m: Member, id: string, amount: number, opts: { claimAtLastBlock?: boolean; restartDaveBeforeClaim?: boolean; watcher?: boolean; travelerClaims?: boolean } = {}) {
  const watcher = opts.watcher ?? true;
  const travelerClaims = opts.travelerClaims ?? true;
  const s = travelerPropose(id, m, amount);
  const d = await daveOffer(id, m, pk[m], s.refundKey, amount);
  const terms = { hash: s.hash, claim: d.claimKey, refund: s.refundKey, timeout: d.timeout };
  const btc0 = await btc(m);
  const ch0 = await chan('dave', m);
  const hLock = await height();
  const t0 = Date.now();
  await travelerLock(s, terms);
  const tLock = Date.now() - t0;
  const invoice = await travelerInvoice(s);
  const verdict = await daveVerify(d, { invoice, announced: terms, outpoint: s.lock!.outpoint, blinding: s.lock!.blinding });
  assert(verdict.pay, `dave refused: ${verdict.failures.join('; ')}`);
  const t1 = Date.now();
  await davePay(d, invoice);
  await waitFor('held on traveler', async () => (await getPayment(m, s.hash, 'InboundHodl'))?.status === 'Claimable', 60_000);
  const tHeld = Date.now() - t1;
  const hPay = d.payHeight!;
  const cltv = heldHtlcCltvExpiry(m, s.hash);
  const deadline = cltv - HTLC_FAIL_BACK_BUFFER;
  const info: Record<string, unknown> = { lockBlock: hLock + 1, payHeight: hPay, T: d.timeout, cltvExpiry: cltv, lnDeadline: deadline, lnDeadlineBound: verdict.lnDeadlineBound, margin: d.timeout - deadline };
  assert(deadline <= verdict.lnDeadlineBound, `measured LN deadline ${deadline} above the bound ${verdict.lnDeadlineBound}`);
  if (!travelerClaims) return { s, d, info };
  if (opts.claimAtLastBlock) {
    const target = deadline - 1;
    if ((await height()) < target) await mine(target - (await height()));
    await sleep(3000);
    info.claimHeight = await height();
  }
  const t2 = Date.now();
  await travelerClaimLn(s);
  const tClaimLn = Date.now() - t2;
  if (opts.restartDaveBeforeClaim) {
    execFileSync('docker', ['restart', 'kitty-kaleido-rln-dave-1']);
    await waitFor('dave API', async () => fetch('http://127.0.0.1:23004/nodeinfo').then(() => true, () => false), 60_000, 1000);
    await setupNode('dave');
    await waitFor('dave channels usable again', async () => (await channels('dave')).filter((c) => c.is_usable).length >= TRAVELERS.length, 120_000, 1000);
    info.daveRestarted = true;
    info.daveRecordStateAfterRestart = daveRecord(id).state; // the watcher reloads from disk
  }
  let did: string[] = [];
  if (watcher) {
    const t3 = Date.now();
    await waitFor('dave sees P', async () => !!(await getPayment('dave', s.hash, 'Outbound'))?.preimage, 60_000);
    did = await daveWatcherTick();
    info.tOnchainClaimMs = Date.now() - t3;
  }
  const rec = daveRecord(id);
  const ch1 = await chan('dave', m);
  info.ms = { lock: tLock, heldAfterPay: tHeld, claimLn: tClaimLn };
  info.watcher = did;
  return {
    s, d: rec, info,
    sats: `traveler on-chain BTC ${btc0}→${await btc(m)} (Δ${(await btc(m)) - btc0}); dave channel sat ${ch0.local_balance_sat}→${ch1.local_balance_sat}`,
    channel: { daveAsset: ch1.asset_local_amount, travelerAsset: ch1.asset_remote_amount },
  };
}

// ======================= setup =======================
await ensureMiner();
for (const m of ['dave', ...TRAVELERS] as Member[]) pk[m] = await setupNode(m);
await fundNode('dave', 1, 5, 1_100_000);
for (const m of TRAVELERS) await fundNode(m, 0.2, 5, 100_000);
const issued = await post('dave', '/issueassetnia', { amounts: [1_000_000], ticker: 'DUSD', name: 'Demo USD', precision: 2 });
assetId = issued.asset.asset_id;
setAssetId(assetId);
for (const w of ['dave-htlc', ...TRAVELERS.map((m) => `${m}-htlc`)]) await sendBtc(tool('address', { wallet: w }).address, 0.02);
await mine(1);
log('setup: nodes, BTC, DUSD issued', { assetId, pk });

await runCase('0. on-ramp 100.00 on-chain to each traveler (RLN → RLN)', async () => {
  for (const m of TRAVELERS) await rlnSend('dave', m, assetId, 10_000);
  for (const m of TRAVELERS) await waitFor(`${m} settled`, async () => (await refresh(m), (await settled(m)) === 10_000), 60_000, 1000);
  return { note: TRAVELERS.map((m) => `${m} 100.00`).join(', ') };
});

await runCase('0. ONE channel dave → each traveler (D + L = 80.00 on dave side, push 300k sat)', async () => {
  for (const m of TRAVELERS) {
    await post('dave', '/openchannel', {
      peer_pubkey_and_opt_addr: `${pk[m]}@${peerAddr(m)}`, capacity_sat: CAPACITY_SAT, push_msat: PUSH_MSAT,
      asset_amount: D + L, asset_id: assetId, public: true, with_anchors: true, fee_base_msat: 0, fee_proportional_millionths: 0,
    });
    await waitFor('funding in mempool', async () => (await mempool()).length > 0, 60_000, 500);
    await mine(1);
  }
  let n = 0;
  while (n < 12) {
    const ok = await Promise.all(TRAVELERS.map(async (m) => (await chan('dave', m))?.is_usable && (await chan(m, 'dave'))?.is_usable));
    if (ok.every(Boolean)) break;
    await mine(1);
    n++;
    await sleep(1000);
  }
  await waitFor('graph has 3 channels on every node', async () => {
    const infos = await Promise.all(TRAVELERS.map((m) => get(m, '/nodeinfo')));
    return infos.every((i) => i.network_channels >= 3);
  }, 120_000, 2000);
  const c = await chan('dave', 'alice');
  const a = await chan('alice', 'dave');
  return { sats: `per channel: dave ${c.local_balance_sat} sat, traveler ${a.local_balance_sat} sat (capacity ${CAPACITY_SAT})`, note: `usable after ${n} extra blocks; dave asset ${c.asset_local_amount}, traveler ${c.asset_remote_amount}` };
});

// ======================= 1. the atomic swap, for each traveler =======================
for (const m of TRAVELERS) {
  await runCase(`1. atomic swap ${m}: D = 50.00 on-chain → his side of the channel`, async () => {
    const before = await settled(m);
    const r = await swap(m, `swap-${m}`, D);
    assert(r.d.state === 'claimed_onchain', `dave state ${r.d.state}`);
    assert(r.channel!.travelerAsset === D && r.channel!.daveAsset === L, `channel ${JSON.stringify(r.channel)}`);
    assert((await settled(m)) === before - D, 'traveler on-chain −D');
    return { sats: r.sats, note: JSON.stringify({ ...r.info, channel: r.channel }) };
  });
}
await runCase('1. dave moves the claimed DUSD to his RLN node', async () => {
  const bal = tool('balance', { wallet: 'dave-htlc', 'asset-id': assetId }).asset.settled as number;
  const before = await settled('dave');
  const rid = await (await import('./htlc.ts')).rlnRgbInvoice('dave', assetId, bal);
  tool('send', { wallet: 'dave-htlc', 'asset-id': assetId, amount: bal, 'recipient-id': rid });
  await mine(1);
  await waitFor('dave settled', async () => (await refresh('dave'), (await settled('dave')) === before + bal), 90_000, 2000);
  return { note: `${bal} units (3 × D) from dave-htlc to dave RLN` };
});

// ======================= 4-6. payments of the kitty model =======================
async function invoicePay(creditor: Member, debtor: Member, cents: number) {
  const { invoice } = await post(creditor, '/lninvoice', { amt_msat: 3_000_000, expiry_sec: 3600, asset_id: assetId, asset_amount: cents, description: `kitty:exp:${creditor}:${debtor}` });
  const { payment_hash } = await post(debtor, '/decodelninvoice', { invoice });
  const before = { cr: (await assetBalance(creditor, assetId)).offchain_outbound, db: (await assetBalance(debtor, assetId)).offchain_outbound };
  const { ms, payment } = await payInvoice(debtor, invoice, payment_hash);
  assert(payment.preimage && sha256hex(payment.preimage) === payment_hash, 'preimage');
  await sleep(500);
  const after = { cr: (await assetBalance(creditor, assetId)).offchain_outbound, db: (await assetBalance(debtor, assetId)).offchain_outbound };
  assert(after.cr - before.cr === cents && before.db - after.db === cents, `balances ${JSON.stringify({ before, after })}`);
  return { ms, note: `preimage ✓ sha256 = hash; ${creditor} ${before.cr}→${after.cr}, ${debtor} ${before.db}→${after.db}; ${ms} ms` };
}
await runCase('4. alice invoice 3.09, bob pays via dave', async () => invoicePay('alice', 'bob', 309));
await runCase('5. charlie pays bob 2.00 (bob receives thanks to L)', async () => invoicePay('bob', 'charlie', 200));
await runCase('6. guarantee: dave pays an invoice of charlie (3.50)', async () => invoicePay('charlie', 'dave', 350));

// ======================= 8, 9 =======================
await runCase('8. traveler claims LN at the last usable block, dave still claims before T', async () => {
  const r = await swap('alice', 'swap-alice-last', 100, { claimAtLastBlock: true });
  assert(r.d.state === 'claimed_onchain' && r.d.claimHeight! < r.d.timeout, 'dave claim before T');
  return { sats: r.sats, note: JSON.stringify({ ...r.info, daveClaimHeight: r.d.claimHeight, blocksLeftToT: r.d.timeout - r.d.claimHeight! }) };
});
await runCase('9. dave restarts between the LN claim and his on-chain claim', async () => {
  const r = await swap('bob', 'swap-bob-restart', 100, { restartDaveBeforeClaim: true });
  assert(r.d.state === 'claimed_onchain', `dave state ${r.d.state}`);
  return { sats: r.sats, note: JSON.stringify(r.info) };
});

// ======================= 2, 3, 10, 11 (they need T to pass) =======================
const pendingRefunds: { label: string; s: TravelerSwap }[] = [];
let case2: { s: TravelerSwap; d: ReturnType<typeof daveRecord> } | undefined;
await runCase('2. traveler does not claim: LN back to dave (refund follows after T)', async () => {
  const before = await chan('dave', 'bob');
  const r = await swap('bob', 'swap-bob-noclaim', 100, { travelerClaims: false });
  case2 = { s: r.s, d: daveRecord('swap-bob-noclaim') };
  return { note: JSON.stringify({ ...r.info, daveAssetBefore: before.asset_local_amount }) };
});
await runCase('3. dave tries to claim on-chain without P: rejected', async () => {
  const d = case2!.d;
  const fake = tool('spend', { wallet: 'dave-htlc', path: 'claim', hash: d.hash!, claim: d.claimKey, refund: d.refundKey, timeout: d.timeout, secret: d.claimSecret, preimage: (await import('./lib.ts')).preimageAndHash().preimage, outpoint: d.outpoint!, 'asset-id': assetId, amount: d.amount, 'no-mark': true });
  const r = await broadcast(fake.tx_hex);
  tool('abort', { wallet: 'dave-htlc', op: fake.operation_id });
  assert(!r.ok, 'fake claim accepted');
  return { note: `node: ${r.ok ? '' : r.error.slice(0, 120)}` };
});
await runCase('2. (cont.) held HTLC fails back at the deadline, dave liquidity restored', async () => {
  const { s } = case2!;
  const cltv = heldHtlcCltvExpiry('bob', s.hash);
  const deadline = cltv - HTLC_FAIL_BACK_BUFFER;
  if ((await height()) < deadline) await mine(deadline - (await height()));
  await waitFor('bob HODL failed', async () => (await mine(1), (await getPayment('bob', s.hash, 'InboundHodl'))?.status === 'Failed'), 120_000, 1000);
  await waitFor('dave payment failed', async () => (await getPayment('dave', s.hash, 'Outbound'))?.status === 'Failed', 60_000);
  const did = await daveWatcherTick();
  const c = await chan('dave', 'bob');
  pendingRefunds.push({ label: '2', s });
  return { note: `failed at ${await height()} (deadline ${deadline}); dave asset on bob channel ${c.asset_local_amount}; watcher: ${did.join('; ')}` };
});

await runCase('10. wrong HTLCs: dave refuses to pay', async () => {
  const notes: string[] = [];
  const variants: { label: string; lockAmount?: number; otherHash?: boolean; tDelta?: number; otherClaimKey?: boolean }[] = [
    { label: 'a lower amount', lockAmount: 90 },
    { label: 'b different hash', otherHash: true },
    { label: 'c T too close', tDelta: 100 },
    { label: 'd claim key not dave', otherClaimKey: true },
  ];
  for (const v of variants) {
    const id = `swap-alice-bad-${v.label[0]}`;
    const s = travelerPropose(id, 'alice', 100);
    const d = await daveOffer(id, 'alice', pk.alice, s.refundKey, 100, v.tDelta);
    const lockTerms = {
      hash: v.otherHash ? (await import('./lib.ts')).preimageAndHash().hash : s.hash,
      claim: v.otherClaimKey ? tool('keygen').xonly : d.claimKey,
      refund: s.refundKey,
      timeout: d.timeout,
    };
    await travelerLock(s, lockTerms, v.lockAmount ?? 100);
    const invoice = await travelerInvoice(s);
    const verdict = await daveVerify(d, { invoice, announced: lockTerms, outpoint: s.lock!.outpoint, blinding: s.lock!.blinding });
    assert(!verdict.pay, `${v.label}: dave would pay`);
    let refused = '';
    try {
      await davePay(daveRecord(id), invoice);
    } catch (e) {
      refused = (e as Error).message;
    }
    assert(refused.startsWith('dave refuses'), `${v.label}: not refused`);
    await post('alice', '/cancelhodlinvoice', { payment_hash: s.hash }).catch(() => undefined);
    pendingRefunds.push({ label: `10${v.label[0]}`, s });
    notes.push(`${v.label}: ${verdict.failures.join(' | ')}`);
  }
  return { note: notes.join(' ;; ') };
});

let case11: { s: TravelerSwap; preimage?: string } | undefined;
await runCase('11. dave watcher stopped: traveler claims LN and later refunds on-chain', async () => {
  const daveCh = await chan('dave', 'charlie');
  const r = await swap('charlie', 'swap-charlie-nowatch', 1000, { watcher: false });
  const after = await chan('dave', 'charlie');
  case11 = { s: r.s };
  pendingRefunds.push({ label: '11', s: r.s });
  return { note: `LN claimed by charlie: dave asset on charlie channel ${daveCh.asset_local_amount}→${after.asset_local_amount}; watcher off; ${JSON.stringify(r.info)}` };
});

await runCase('2/10/11. refunds after T, back to the RLN nodes', async () => {
  const notes: string[] = [];
  for (const p of pendingRefunds.sort((a, b) => a.s.terms!.timeout - b.s.terms!.timeout)) {
    const before = await settled(p.s.traveler);
    const r = await travelerRefund(p.s);
    notes.push(`${p.label} ${p.s.traveler} +${(await settled(p.s.traveler)) - before} (refund ${r.refundTxid.slice(0, 8)})`);
  }
  return { note: notes.join('; ') };
});

await runCase('11. (cont.) dave wakes up after the refund: his claim fails, loss measured', async () => {
  const s = case11!.s;
  const d = daveRecord('swap-charlie-nowatch');
  const p = await getPayment('dave', s.hash, 'Outbound');
  const late = tool('spend', { wallet: 'dave-htlc', path: 'claim', hash: d.hash!, claim: d.claimKey, refund: d.refundKey, timeout: d.timeout, secret: d.claimSecret, preimage: p!.preimage!, outpoint: d.outpoint!, 'asset-id': assetId, amount: d.amount, 'no-mark': true }) as { tx_hex: string; operation_id: string };
  const r = await broadcast(late.tx_hex);
  tool('abort', { wallet: 'dave-htlc', op: late.operation_id });
  assert(!r.ok, 'late claim should fail: the HTLC is already refunded');
  const ch = await chan('charlie', 'dave');
  return { note: `late claim: ${r.ok ? '' : r.error.slice(0, 80)}; dave lost ${d.amount} units (10.00 DUSD) + 3000 sat of the HTLC; charlie has ${ch.asset_local_amount} in the channel and got ${d.amount} back on-chain. The watcher is critical.` };
});

// ======================= 7. close charlie's channel =======================
await runCase('7. dave closes charlie channel: DUSD back to charlie on-chain after the sweep', async () => {
  const c = await chan('dave', 'charlie');
  const charlieSide = c.asset_remote_amount!;
  const before = await settled('charlie');
  const hClose = await height();
  await post('dave', '/closechannel', { channel_id: c.channel_id, peer_pubkey: pk.charlie, force: false });
  await waitFor('close tx in mempool', async () => (await mempool()).length > 0, 60_000, 500);
  let n = 0;
  while (n < 14) {
    await mine(1);
    n++;
    await refresh('charlie');
    if ((await settled('charlie')) === before + charlieSide) break;
  }
  assert((await settled('charlie')) === before + charlieSide, `charlie settled ${await settled('charlie')} expected ${before + charlieSide}`);
  return { note: `charlie side ${charlieSide} → on-chain after ${n} blocks (close at ${hClose}); charlie settled ${before}→${await settled('charlie')}` };
});

// ======================= conservation =======================
await runCase('conservation of the issued 1,000,000 units', async () => {
  for (const m of ['dave', ...TRAVELERS] as Member[]) await refresh(m);
  let total = 0;
  const parts: string[] = [];
  for (const m of ['dave', ...TRAVELERS] as Member[]) {
    const b = await assetBalance(m, assetId);
    total += b.settled + b.offchain_outbound;
    parts.push(`${m} ${b.settled}+${b.offchain_outbound}`);
  }
  for (const w of ['dave-htlc', ...TRAVELERS.map((m) => `${m}-htlc`)]) {
    const s = (tool('balance', { wallet: w, 'asset-id': assetId }).asset?.settled as number | undefined) ?? 0;
    total += s;
    parts.push(`${w} ${s}`);
  }
  assert(total === 1_000_000, `total ${total}`);
  return { note: `${parts.join(', ')} = ${total}` };
});

// ======================= report =======================
console.log('\n================ STAGE 3 RESULTS ================');
for (const r of rows) console.log(`${r.ok ? 'PASS' : 'FAIL'} | ${r.case} | blocks ${r.blocks} | ${(r.ms / 1000).toFixed(1)} s${r.sats ? ` | ${r.sats}` : ''}`);
console.log(`\n${rows.filter((r) => r.ok).length}/${rows.length} passed; margin rule: dave pays only if T − LN deadline bound ≥ ${MARGIN_BLOCKS}`);
writeFileSync(new URL('../.out/stage3-results.json', import.meta.url), JSON.stringify(rows, null, 2));
process.exit(rows.every((r) => r.ok) ? 0 : 1);
