import { mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkBindInvoice, PaymentProofSchema, sha256Hex, signatureVerifier } from '@kitty/shared';
import { describe, expect, it } from 'vitest';
import { LightningRail } from '../rail/lightning-rail.js';
import { WalletError } from './errors.js';
import { deriveAppSecretHex, normalizeMnemonic, RlnWallet } from './rln-wallet.js';
import {
  ALICE_NODE,
  ASSET,
  decoded,
  FakeRln,
  PAYMENT_HASH,
  payment,
  PREIMAGE,
  rlnError,
  channel,
  CHARLIE_NODE,
  DAVE_NODE,
  FakeChain,
  LIQ_FUNDING,
  TRIP_FUNDING,
} from './test/fake-rln.js';

// BIP-39 test mnemonic (never a real wallet). Expected values computed once and cross-checked:
// the secret against an independent HKDF-SHA256 in Python, the public key with @noble/curves.
const TEST_MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const TEST_APP_SECRET = 'cf92a79ac618944a5cb76c837e9189da1d825ec4b5d766e131472331cfdddce4';
const TEST_APP_PUBKEY = 'e33fe1b9405c076379116fa854c93edd006a36076d3e687c68b94362c7fbd14b';

function setup(
  rln = new FakeRln(),
  over: Partial<ConstructorParameters<typeof RlnWallet>[0]> = {},
) {
  const wallet = new RlnWallet({
    nodeUrl: 'http://127.0.0.1:3001',
    appSecretHex: TEST_APP_SECRET,
    assetId: ASSET,
    fetch: rln.fetch,
    pollIntervalMs: 1,
    ...over,
  });
  return { rln, wallet };
}

async function codeOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(WalletError);
    return (e as WalletError).code;
  }
  throw new Error('expected a WalletError, the call succeeded');
}

describe('app key (decision B3, option A)', () => {
  it('derives the expected key from the test mnemonic', async () => {
    expect(deriveAppSecretHex(TEST_MNEMONIC)).toBe(TEST_APP_SECRET);
    expect(await setup().wallet.authorPubkey()).toBe(TEST_APP_PUBKEY);
  });

  it('normalizes the mnemonic first: trim, single spaces, lowercase, NFKD', () => {
    const messy = `  ${TEST_MNEMONIC.toUpperCase().replaceAll(' ', ' \t\n ')}\n`;
    expect(deriveAppSecretHex(messy)).toBe(TEST_APP_SECRET);
    expect(normalizeMnemonic('café  BAR')).toBe(normalizeMnemonic(' café bar'));
    expect(deriveAppSecretHex('café x')).toBe(deriveAppSecretHex('café x'));
    expect(deriveAppSecretHex(`${TEST_MNEMONIC} abandon`)).not.toBe(TEST_APP_SECRET);
    expect(() => deriveAppSecretHex('   ')).toThrow();
  });
});

describe('RlnWallet identity and signing', () => {
  it('signs with ed25519 (the B4 format), never via the node', async () => {
    const { rln, wallet } = setup();
    const sig = await wallet.sign('{"type":"LINE_SEEN"}');
    expect(signatureVerifier.verify(TEST_APP_PUBKEY, '{"type":"LINE_SEEN"}', sig)).toBe(true);
    expect(signatureVerifier.verify(TEST_APP_PUBKEY, '{"type":"LINE_DECIDED"}', sig)).toBe(false);
    expect(rln.calls).toHaveLength(0);
  });

  it('reads nodePubkey from /nodeinfo once, and retries after a failure', async () => {
    const rln = new FakeRln();
    let first = true;
    rln.on('/nodeinfo', () => {
      if (first) {
        first = false;
        return rlnError(403, 'LockedNode');
      }
      return { json: { pubkey: ALICE_NODE, rgb_htlc_min_msat: 3_000_000 } };
    });
    const { wallet } = setup(rln);
    expect(await codeOf(wallet.nodePubkey())).toBe('NODE_UNREACHABLE');
    expect(await wallet.nodePubkey()).toBe(ALICE_NODE);
    expect(await wallet.nodePubkey()).toBe(ALICE_NODE);
    expect(rln.count('/nodeinfo')).toBe(2);
  });

  it('bindInvoice uses the FakeWallet description and passes checkBindInvoice', async () => {
    const rln = new FakeRln();
    const desc = `kitty-bind:${sha256Hex(TEST_APP_PUBKEY)}`;
    rln.on('/decodelninvoice', () => ({ json: decoded({ asset_amount: 1, description: desc }) }));
    const { wallet } = setup(rln);
    const bolt11 = await wallet.bindInvoice(TEST_APP_PUBKEY);
    expect(rln.calls.find((c) => c.endpoint === '/lninvoice')?.body.description).toBe(desc);
    const d = await wallet.decodeInvoice(bolt11);
    expect(checkBindInvoice(d, TEST_APP_PUBKEY, ALICE_NODE)).toBe(true);
  });
});

describe('RlnWallet invoices and balances', () => {
  it('creates an RGB invoice with amt_msat = rgb_htlc_min_msat (spike Q9)', async () => {
    const { rln, wallet } = setup();
    const r = await wallet.createInvoice({
      cents: 309n,
      description: 'kitty:t:e:bob',
      expirySec: 3600,
    });
    expect(r).toEqual({ bolt11: 'lnbcrt30u1fake', paymentHash: PAYMENT_HASH });
    expect(rln.calls.find((c) => c.endpoint === '/lninvoice')?.body).toEqual({
      amt_msat: 3_000_000,
      expiry_sec: 3600,
      asset_id: ASSET,
      asset_amount: 309,
      description: 'kitty:t:e:bob',
    });
  });

  it('refuses an invoice the node created for another amount or payee', async () => {
    const rln = new FakeRln().on('/decodelninvoice', () => ({
      json: decoded({ asset_amount: 310 }),
    }));
    expect(
      await codeOf(
        setup(rln).wallet.createInvoice({ cents: 309n, description: 'x', expirySec: 60 }),
      ),
    ).toBe('INTERNAL');
  });

  it('rejects zero or negative amounts before calling the node', async () => {
    const { rln, wallet } = setup();
    expect(await codeOf(wallet.createInvoice({ cents: 0n, description: 'x', expirySec: 60 }))).toBe(
      'VALIDATION_ERROR',
    );
    expect(rln.count('/lninvoice')).toBe(0);
  });

  it('decodes expiresAt = timestamp + expiry_sec', async () => {
    const rln = new FakeRln().on('/decodelninvoice', () => ({
      json: decoded({ timestamp: 1_792_138_948, expiry_sec: 3600 }),
    }));
    const d = await setup(rln).wallet.decodeInvoice('lnbcrt30u1fake');
    expect(d).toMatchObject({
      payeePubkey: ALICE_NODE,
      cents: 309n,
      amtMsat: 3_000_000n,
      assetId: ASSET,
    });
    expect(d.expiresAt).toBe(new Date((1_792_138_948 + 3600) * 1000).toISOString());
  });

  it('maps /assetbalance to the three balances (spike, surprise 9)', async () => {
    expect(await setup().wallet.balances()).toEqual({
      tripOutboundCents: 5000n,
      inboundCents: 3000n,
      onchainCents: 5000n,
    });
  });
});

describe('RlnWallet.pay', () => {
  it('sends, polls until Succeeded and returns a verifiable proof', async () => {
    const rln = new FakeRln();
    let polls = 0;
    rln.on('/getpayment', () => ({ json: payment(++polls < 3 ? 'Pending' : 'Succeeded') }));
    const proof = await setup(rln).wallet.pay('lnbcrt30u1fake');
    expect(PaymentProofSchema.safeParse({ ...proof, cents: String(proof.cents) }).success).toBe(
      true,
    );
    expect(proof).toEqual({
      rail: 'ln',
      paymentHash: PAYMENT_HASH,
      preimage: PREIMAGE,
      cents: 309n,
      payeePubkey: ALICE_NODE,
    });
    expect(polls).toBe(3);
  });

  it('refuses an expired invoice without sending anything', async () => {
    const rln = new FakeRln().on('/decodelninvoice', () => ({
      json: decoded({ timestamp: Math.floor(Date.now() / 1000) - 100, expiry_sec: 60 }),
    }));
    expect(await codeOf(setup(rln).wallet.pay('lnbcrt30u1fake'))).toBe('INVOICE_EXPIRED');
    expect(rln.count('/sendpayment')).toBe(0);
  });

  it('refuses an invoice of another asset or with no amount', async () => {
    for (const over of [{ asset_id: 'rgb:other' }, { asset_amount: null }]) {
      const rln = new FakeRln().on('/decodelninvoice', () => ({ json: decoded(over) }));
      expect(await codeOf(setup(rln).wallet.pay('lnbcrt30u1fake'))).toBe('VALIDATION_ERROR');
      expect(rln.count('/sendpayment')).toBe(0);
    }
  });

  it('asks for a top-up when the channel cannot send the amount, without sending', async () => {
    const rln = new FakeRln().on('/assetbalance', () => ({
      json: { settled: 0, future: 0, spendable: 0, offchain_outbound: 308, offchain_inbound: 0 },
    }));
    expect(await codeOf(setup(rln).wallet.pay('lnbcrt30u1fake'))).toBe('TOPUP_REQUIRED');
    expect(rln.count('/sendpayment')).toBe(0);
  });

  it('fails when /sendpayment answers Failed with HTTP 200 (spike Q10)', async () => {
    const rln = new FakeRln().on('/sendpayment', () => ({
      json: { payment_id: PAYMENT_HASH, status: 'Failed' },
    }));
    expect(await codeOf(setup(rln).wallet.pay('lnbcrt30u1fake'))).toBe('PAYMENT_FAILED');
    expect(rln.count('/getpayment')).toBe(0);
  });

  it('fails when the payment ends Failed', async () => {
    const rln = new FakeRln().on('/getpayment', () => ({ json: payment('Failed') }));
    expect(await codeOf(setup(rln).wallet.pay('lnbcrt30u1fake'))).toBe('PAYMENT_FAILED');
  });

  it('times out on a payment that stays Pending, saying it may still complete', async () => {
    const rln = new FakeRln().on('/getpayment', () => ({ json: payment('Pending') }));
    const p = setup(rln, { payTimeoutMs: 30 }).wallet.pay('lnbcrt30u1fake');
    await expect(p).rejects.toMatchObject({
      code: 'PAYMENT_FAILED',
      action: expect.stringMatching(/Do not pay again/),
    });
  });

  it('keeps polling through transient errors while the payment moves', async () => {
    const rln = new FakeRln();
    let polls = 0;
    rln.on('/getpayment', () => (++polls === 1 ? 'network-error' : { json: payment('Succeeded') }));
    expect((await setup(rln).wallet.pay('lnbcrt30u1fake')).preimage).toBe(PREIMAGE);
  });

  it('is idempotent: DuplicatePayment resolves through /getpayment', async () => {
    const rln = new FakeRln().on('/sendpayment', () => rlnError(400, 'DuplicatePayment'));
    expect((await setup(rln).wallet.pay('lnbcrt30u1fake')).preimage).toBe(PREIMAGE);
    const failed = new FakeRln()
      .on('/sendpayment', () => rlnError(400, 'DuplicatePayment'))
      .on('/getpayment', () => ({ json: payment('Failed') }));
    expect(await codeOf(setup(failed).wallet.pay('lnbcrt30u1fake'))).toBe('PAYMENT_FAILED');
  });

  it('an ambiguous /sendpayment answer is resolved by asking the node', async () => {
    for (const reply of [
      'network-error',
      { status: 500, text: 'oops' },
      { status: 200, text: 'x' },
    ] as const) {
      const left = new FakeRln().on('/sendpayment', () => reply);
      expect((await setup(left).wallet.pay('lnbcrt30u1fake')).preimage).toBe(PREIMAGE);
      const notSent = new FakeRln()
        .on('/sendpayment', () => reply)
        .on('/getpayment', () => rlnError(400, 'PaymentNotFound'));
      expect(await codeOf(setup(notSent).wallet.pay('lnbcrt30u1fake'))).toBe('PAYMENT_FAILED');
    }
  });

  it.each([
    ['a wrong preimage', { preimage: 'ff'.repeat(32) }],
    ['no preimage', { preimage: null }],
    ['another payment hash', { payment_hash: 'ee'.repeat(32) }],
    ['another amount', { asset_amount: 1 }],
    ['another asset', { asset_id: 'rgb:other' }],
    ['another payee', { payee_pubkey: `02${'11'.repeat(32)}` }],
    ['an inbound payment', { inbound: true }],
  ])('never reports success on a Succeeded payment with %s', async (_label, over) => {
    const rln = new FakeRln().on('/getpayment', () => ({ json: payment('Succeeded', over) }));
    expect(await codeOf(setup(rln).wallet.pay('lnbcrt30u1fake'))).toBe('INTERNAL');
  });

  it('runs one payment at a time per wallet', async () => {
    const rln = new FakeRln();
    let inFlight = 0;
    let maxInFlight = 0;
    let polls = 0;
    rln.on('/sendpayment', () => {
      maxInFlight = Math.max(maxInFlight, ++inFlight);
      return { json: { payment_id: PAYMENT_HASH, status: 'Pending' } };
    });
    rln.on('/getpayment', () => {
      if (++polls % 3 !== 0) return { json: payment('Pending') };
      inFlight--;
      return { json: payment('Succeeded') };
    });
    const { wallet } = setup(rln);
    await Promise.all([wallet.pay('a'), wallet.pay('b'), wallet.pay('c')]);
    expect(maxInFlight).toBe(1);
    expect(rln.count('/sendpayment')).toBe(3);
  });

  it('a failed payment does not block the next one', async () => {
    const rln = new FakeRln();
    let n = 0;
    rln.on('/sendpayment', () => ({
      json: { payment_id: PAYMENT_HASH, status: ++n === 1 ? 'Failed' : 'Pending' },
    }));
    const { wallet } = setup(rln);
    const [a, b] = await Promise.allSettled([wallet.pay('a'), wallet.pay('b')]);
    expect(a.status).toBe('rejected');
    expect(b.status).toBe('fulfilled');
  });
});

describe('RLN errors become WalletError codes', () => {
  it.each([
    ['LockedNode', 403, 'NODE_UNREACHABLE'],
    ['NotInitialized', 403, 'NODE_UNREACHABLE'],
    ['InsufficientCapacity', 400, 'TOPUP_REQUIRED'],
    ['InsufficientAssets', 400, 'TOPUP_REQUIRED'],
    ['InvalidInvoice', 400, 'VALIDATION_ERROR'],
    ['NoAvailableUtxos', 400, 'NO_AVAILABLE_UTXOS'],
    ['SomethingNew', 400, 'PAYMENT_FAILED'],
  ])('/sendpayment %s → %s', async (name, status, code) => {
    const rln = new FakeRln().on('/sendpayment', () => rlnError(status, name));
    expect(await codeOf(setup(rln).wallet.pay('lnbcrt30u1fake'))).toBe(code);
  });

  it('an unreachable node is NODE_UNREACHABLE', async () => {
    const rln = new FakeRln().on('/assetbalance', () => 'network-error');
    expect(await codeOf(setup(rln).wallet.balances())).toBe('NODE_UNREACHABLE');
  });

  it.each([
    ['plain text', { status: 500, text: 'Internal Server Error' }],
    ['an empty body', { status: 502, text: '' }],
    ['a body of another shape', { status: 400, json: { message: 'nope' } }],
    ['a partial RLN body', { status: 403, json: { error: 'locked', name: 'LockedNode' } }],
    ['a 200 that is not JSON', { status: 200, text: 'not json' }],
  ])(
    'a malformed error (%s) gets a generic code, never a crash or a success',
    async (_l, reply) => {
      const pay = new FakeRln()
        .on('/sendpayment', () => reply)
        .on('/getpayment', () => rlnError(400, 'PaymentNotFound'));
      expect(await codeOf(setup(pay).wallet.pay('lnbcrt30u1fake'))).toBe('PAYMENT_FAILED');
      const bal = new FakeRln().on('/assetbalance', () => reply);
      expect(await codeOf(setup(bal).wallet.balances())).toBe('INTERNAL');
    },
  );

  it('a 200 with an unexpected body is INTERNAL, not a value', async () => {
    const rln = new FakeRln().on('/assetbalance', () => ({ json: { settled: 'lots' } }));
    expect(await codeOf(setup(rln).wallet.balances())).toBe('INTERNAL');
  });
});

describe('balances refresh transfers (B7: swept closes show on-chain)', () => {
  it('calls /refreshtransfers with the spike body, at most once per interval', async () => {
    let t = 0;
    const { rln, wallet } = setup(undefined, { now: () => t, refreshEveryMs: 15_000 });
    rln.on('/refreshtransfers', () => ({ json: { transfers: {} } }));
    await wallet.balances();
    await wallet.balances();
    expect(rln.count('/refreshtransfers')).toBe(1);
    expect(rln.calls.find((c) => c.endpoint === '/refreshtransfers')?.body).toEqual({
      asset_id: null,
      filter: [],
      skip_sync: false,
    });
    t = 15_000;
    await wallet.balances();
    expect(rln.count('/refreshtransfers')).toBe(2);
  });

  it('a failed refresh still returns the balance', async () => {
    const { rln, wallet } = setup();
    rln.on('/refreshtransfers', () => rlnError(500, 'Unexpected'));
    expect((await wallet.balances()).onchainCents).toBe(5000n);
  });
});

describe('closeChannelsWith (B7)', () => {
  function daveSetup(chain = new FakeChain(), over: { sweepWaitMs?: number } = {}) {
    const rln = new FakeRln()
      .on('/nodeinfo', () => ({ json: { pubkey: DAVE_NODE, rgb_htlc_min_msat: 3_000_000 } }))
      .on('/listchannels', () => ({
        json: {
          channels: [
            channel('trip', TRIP_FUNDING),
            channel('liq', LIQ_FUNDING),
            channel('other', 'aa'.repeat(32), { peer_pubkey: DAVE_NODE.replace('02', '03') }),
          ],
        },
      }))
      .on('/listpeers', () => ({ json: { peers: [{ pubkey: CHARLIE_NODE }] } }))
      .on('/closechannel', (b) => {
        chain.close(b.channel_id === 'trip' ? TRIP_FUNDING : LIQ_FUNDING);
        return { json: {} };
      })
      .on('/refreshtransfers', () => ({ json: { transfers: {} } }));
    const { wallet } = setup(rln, {
      coordinator: {
        esplora: chain.esplora,
        miner: chain.miner,
        blockWaitMs: 0,
        mempoolTimeoutMs: 50,
        sweepWaitMs: 5,
        ...over,
      },
    });
    return { rln, wallet, chain };
  }

  it('is refused on any wallet but dave, before touching the node', async () => {
    const { rln, wallet } = setup();
    expect(await codeOf(wallet.closeChannelsWith(CHARLIE_NODE))).toBe('NOT_ALLOWED');
    expect(rln.calls).toEqual([]);
  });

  it('closes both channels cooperatively, confirms, waits for the sweep, links esplora', async () => {
    const { rln, wallet, chain } = daveSetup();
    const r = await wallet.closeChannelsWith(CHARLIE_NODE);
    expect(r.txids).toHaveLength(2);
    expect(r.explorerUrls).toEqual(r.txids.map((t) => `http://127.0.0.1:3010/tx/${t}`));
    expect(r.swept).toBe(true);
    // 1 block to confirm, then the sweep confirms 6 blocks later (spike Q7: h164 → h170)
    expect(r.blocksMined).toBe(7);
    expect(chain.mined).toBe(7);
    const closes = rln.calls.filter((c) => c.endpoint === '/closechannel');
    expect(closes.map((c) => c.body)).toEqual([
      { channel_id: 'trip', peer_pubkey: CHARLIE_NODE, force: false },
      { channel_id: 'liq', peer_pubkey: CHARLIE_NODE, force: false },
    ]);
    for (const t of r.txids) expect(chain.txs.get(t)?.status.confirmed).toBe(true);
    expect(rln.count('/refreshtransfers')).toBe(1);
  });

  it('never forces: an offline member closes nothing', async () => {
    const { rln, wallet } = daveSetup();
    rln.on('/listpeers', () => ({ json: { peers: [] } }));
    expect(await codeOf(wallet.closeChannelsWith(CHARLIE_NODE))).toBe('RECEIVER_UNREACHABLE');
    expect(rln.count('/closechannel')).toBe(0);
  });

  it('no channel with the member is NOT_FOUND', async () => {
    const { rln, wallet } = daveSetup();
    rln.on('/listchannels', () => ({ json: { channels: [] } }));
    expect(await codeOf(wallet.closeChannelsWith(CHARLIE_NODE))).toBe('NOT_FOUND');
  });

  it('a channel not Opened stops everything before any close', async () => {
    const { rln, wallet } = daveSetup();
    rln.on('/listchannels', () => ({
      json: {
        channels: [
          channel('trip', TRIP_FUNDING),
          channel('liq', LIQ_FUNDING, { status: 'Closing' }),
        ],
      },
    }));
    expect(await codeOf(wallet.closeChannelsWith(CHARLIE_NODE))).toBe('INTERNAL');
    expect(rln.count('/closechannel')).toBe(0);
  });

  it('a refused second close says which channel is already closing, and never forces', async () => {
    const { rln, wallet, chain } = daveSetup();
    rln.on('/closechannel', (b) => {
      if (b.channel_id === 'liq') return rlnError(400, 'FailedClosingChannel');
      chain.close(TRIP_FUNDING);
      return { json: {} };
    });
    const err = await wallet.closeChannelsWith(CHARLIE_NODE).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(WalletError);
    expect((err as WalletError).message).toMatch(/liq refused .*already closing: trip/);
    expect(rln.calls.every((c) => c.body.force !== true)).toBe(true);
  });

  it('a close that never reaches the mempool fails clearly after the timeout', async () => {
    const { rln, wallet, chain } = daveSetup();
    rln.on('/closechannel', () => ({ json: {} }));
    const err = await wallet.closeChannelsWith(CHARLIE_NODE).catch((e: unknown) => e);
    expect((err as WalletError).message).toMatch(/no closing tx after 50 ms for trip, liq/);
    expect((err as WalletError).action).toMatch(/Not forcing/);
    expect(chain.mined).toBe(0);
  });

  it('waits for the sweeps instead of mining past them', async () => {
    const chain = new FakeChain();
    chain.broadcastDelayMs = 30;
    const { wallet } = daveSetup(chain, { sweepWaitMs: 5_000 });
    const r = await wallet.closeChannelsWith(CHARLIE_NODE);
    expect(r).toMatchObject({ swept: true, blocksMined: 7 });
  });

  it('stops at the 12-block budget and reports swept: false', async () => {
    const chain = new FakeChain();
    chain.sweepAfter = 100;
    const { wallet } = daveSetup(chain);
    const r = await wallet.closeChannelsWith(CHARLIE_NODE);
    expect(r).toMatchObject({ swept: false, blocksMined: 12 });
    expect(chain.mined).toBe(12);
  });

  it('rejects a malformed pubkey', async () => {
    const { rln, wallet } = daveSetup();
    expect(await codeOf(wallet.closeChannelsWith('nope'))).toBe('VALIDATION_ERROR');
    expect(rln.calls).toEqual([]);
  });
});

describe('openLiquidity (B9)', () => {
  const NEW_FUNDING = 'cd'.repeat(32);
  function daveSetup(opts: { refuseFirst?: boolean } = {}) {
    const chain = new FakeChain();
    let opened = false;
    let openedAt = 0;
    let refused = false;
    const rln = new FakeRln()
      .on('/listchannels', () => ({
        json: {
          channels: opened
            ? [
                {
                  channel_id: 'new-liq',
                  peer_pubkey: CHARLIE_NODE,
                  status: 'Opened',
                  funding_txid: NEW_FUNDING,
                  capacity_sat: 1_000_000,
                  // usable after 6 confirmations
                  ready: chain.height - openedAt >= 6,
                  is_usable: chain.height - openedAt >= 6,
                },
              ]
            : [],
        },
      }))
      .on('/openchannel', () => {
        if (opts.refuseFirst && !refused) {
          refused = true;
          return { status: 403, json: { error: 'busy', code: 403, name: 'InsufficientAssets' } };
        }
        opened = true;
        openedAt = chain.height;
        chain.addTx(NEW_FUNDING, [{ value: 1_000_000, scriptpubkey_type: 'v0_p2wsh' }]);
        return { json: { temporary_channel_id: 'tmp' } };
      });
    const { wallet } = setup(rln, {
      coordinator: {
        esplora: chain.esplora,
        miner: chain.miner,
        blockWaitMs: 0,
        mempoolTimeoutMs: 50,
      },
    });
    return { rln, wallet, chain };
  }

  it('is refused on any wallet but dave, before touching the node', async () => {
    const { rln, wallet } = setup();
    expect(await codeOf(wallet.openLiquidity(CHARLIE_NODE, 100n))).toBe('NOT_ALLOWED');
    expect(rln.calls).toEqual([]);
  });

  it('opens a public DUSD channel like the seed, then mines until it is usable', async () => {
    const { rln, wallet, chain } = daveSetup();
    expect(await wallet.openLiquidity(CHARLIE_NODE, 2500n)).toEqual({ channelId: 'new-liq' });
    expect(rln.calls.find((c) => c.endpoint === '/openchannel')?.body).toEqual({
      peer_pubkey_and_opt_addr: CHARLIE_NODE,
      capacity_sat: 1_000_000,
      push_msat: 0,
      asset_amount: 2500,
      asset_id: ASSET,
      public: true,
      with_anchors: true,
      fee_base_msat: 0,
      fee_proportional_millionths: 0,
    });
    expect(chain.mined).toBe(6);
  });

  it('retries once after a block when the node refuses the open', async () => {
    const { rln, wallet, chain } = daveSetup({ refuseFirst: true });
    await wallet.openLiquidity(CHARLIE_NODE, 100n);
    expect(rln.count('/openchannel')).toBe(2);
    expect(chain.mined).toBe(7);
  });

  it('rejects a bad amount or pubkey before touching the node', async () => {
    const { rln, wallet } = daveSetup();
    expect(await codeOf(wallet.openLiquidity(CHARLIE_NODE, 0n))).toBe('VALIDATION_ERROR');
    expect(await codeOf(wallet.openLiquidity('nope', 1n))).toBe('VALIDATION_ERROR');
    expect(rln.calls).toEqual([]);
  });
});

describe('backupNow (B6)', () => {
  function backupSetup(opts: { failBackup?: boolean } = {}) {
    const hostDir = mkdtempSync(join(tmpdir(), 'kitty-backup-'));
    const rln = new FakeRln()
      .on('/lock', () => ({ json: {} }))
      .on('/backup', (b) => {
        if (opts.failBackup)
          return { status: 500, json: { error: 'disk full', code: 500, name: 'IO' } };
        // the container writes into the folder bind-mounted at /backups
        writeFileSync(join(hostDir, String(b.backup_path).replace('/backups/', '')), 'ENCRYPTED');
        return { json: {} };
      })
      .on('/unlock', () => ({ json: {} }))
      .on('/nodeinfo', () => ({
        json: {
          pubkey: ALICE_NODE,
          rgb_htlc_min_msat: 3_000_000,
          num_channels: 2,
          num_usable_channels: 2,
        },
      }));
    const backup = { password: 'pw', unlockBody: { password: 'pw' }, hostDir };
    const { wallet } = setup(rln, { backup });
    return { rln, wallet, hostDir };
  }

  it('is refused without backup settings, before touching the node', async () => {
    const { rln, wallet } = setup();
    expect(await codeOf(wallet.backupNow())).toBe('NOT_ALLOWED');
    expect(rln.calls).toEqual([]);
  });

  it('locks, backs up into /backups, unlocks, and returns the file (then removes it)', async () => {
    const { rln, wallet, hostDir } = backupSetup();
    const { blob } = await wallet.backupNow();
    expect(new TextDecoder().decode(blob)).toBe('ENCRYPTED');
    expect(rln.calls.map((c) => c.endpoint).slice(0, 3)).toEqual(['/lock', '/backup', '/unlock']);
    expect(rln.calls[1]?.body).toMatchObject({
      password: 'pw',
      backup_path: expect.stringMatching(/^\/backups\/backup-\d+\.bin$/),
    });
    expect(rln.calls[2]?.body).toEqual({ password: 'pw' });
    expect(readdirSync(hostDir)).toEqual([]);
  });

  it('always unlocks, even when the backup fails', async () => {
    const { rln, wallet } = backupSetup({ failBackup: true });
    expect(await codeOf(wallet.backupNow())).toBeDefined();
    expect(rln.count('/unlock')).toBe(1);
  });

  it('a payment asked during a backup waits for the unlock', async () => {
    const { rln, wallet } = backupSetup();
    const backup = wallet.backupNow();
    const pay = wallet.pay('lnbc-not-decoded').catch(() => undefined);
    await Promise.all([backup, pay]);
    const order = rln.calls.map((c) => c.endpoint);
    expect(order.indexOf('/unlock')).toBeLessThan(order.indexOf('/decodelninvoice'));
  });
});

describe('LightningRail', () => {
  it('requests with an invoice and pays it, returning the matching proof', async () => {
    const { wallet } = setup();
    const rail = new LightningRail(wallet);
    const req = await rail.requestPayment({
      cents: 309n,
      description: 'kitty:t:e:bob',
      expirySec: 3600,
    });
    expect(req).toMatchObject({ rail: 'ln', bolt11: 'lnbcrt30u1fake', paymentHash: PAYMENT_HASH });
    expect((await rail.pay(req)).paymentHash).toBe(PAYMENT_HASH);
  });

  it('refuses an on-chain request', async () => {
    const rail = new LightningRail(setup().wallet);
    const req = {
      rail: 'onchain' as const,
      invoice: 'rgb:x',
      recipientId: 'r',
      expiresAt: new Date(),
    };
    expect(await codeOf(rail.pay(req))).toBe('VALIDATION_ERROR');
  });
});
