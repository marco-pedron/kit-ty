import { PaymentProofSchema, ReceiptSchema, fakeVerify, sha256Hex } from '@kitty/shared';
import { allocateExpense } from '@kitty/ledger';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { DEMO_RECEIPT, DEMO_SENTENCE, DEMO_SPLIT, createFakeAi } from './fake-ai.js';
import { FakeLightningNetwork } from './fake-wallet.js';
import { FAKES_BANNER, assertNoFakes, fakesOn } from './guard.js';

beforeEach(() => vi.stubEnv('KITTY_FAKES', '1'));
afterEach(() => vi.unstubAllEnvs());

describe('guard', () => {
  it('assertNoFakes refuses KITTY_FAKES=1 and allows it off', () => {
    expect(() => assertNoFakes({ KITTY_FAKES: '1' })).toThrow(/KITTY_FAKES=1/);
    expect(() => assertNoFakes({})).not.toThrow();
    expect(fakesOn({ KITTY_FAKES: '1' })).toBe(true);
    expect(FAKES_BANNER).toMatch(/FAKES ON/);
  });

  it('fakes cannot be built with fakes off', () => {
    vi.stubEnv('KITTY_FAKES', '0');
    expect(() => new FakeLightningNetwork()).toThrow(/KITTY_FAKES=1/);
    expect(() => createFakeAi()).toThrow(/KITTY_FAKES=1/);
  });
});

describe('FakeWallet', () => {
  it('alice invoices, bob pays through the fake hub, the proof verifies, balances move', async () => {
    const net = new FakeLightningNetwork();
    const alice = net.wallet('alice');
    const bob = net.wallet('bob');
    const { bolt11, paymentHash } = await alice.createInvoice({
      cents: 309n,
      description: 'kitty:vietnam-2026:e1:bob',
      expirySec: 3600,
    });
    const decoded = await bob.decodeInvoice(bolt11);
    expect(decoded.payeePubkey).toBe(await alice.nodePubkey());
    expect(decoded.cents).toBe(309n);

    const proof = await bob.pay(bolt11);
    z.encode(PaymentProofSchema, proof); // throws if the proof breaks the contract
    if (proof.rail !== 'ln') throw new Error('expected ln');
    expect(proof.paymentHash).toBe(paymentHash);
    expect(sha256Hex(Buffer.from(proof.preimage, 'hex'))).toBe(paymentHash);

    expect((await bob.balances()).tripOutboundCents).toBe(4691n);
    expect((await alice.balances()).tripOutboundCents).toBe(5309n);
    await expect(bob.pay(bolt11)).rejects.toMatchObject({ code: 'PAYMENT_FAILED' });
  });

  it('maps an expired invoice and a low channel to shared error codes', async () => {
    const net = new FakeLightningNetwork();
    const alice = net.wallet('alice');
    const bob = net.wallet('bob', {
      tripOutboundCents: 100n,
      inboundCents: 3000n,
      onchainCents: 0n,
    });
    const big = await alice.createInvoice({ cents: 309n, description: 'x', expirySec: 3600 });
    await expect(bob.pay(big.bolt11)).rejects.toMatchObject({ code: 'TOPUP_REQUIRED' });
    vi.useFakeTimers();
    const old = await alice.createInvoice({ cents: 50n, description: 'x', expirySec: 1 });
    vi.advanceTimersByTime(2000);
    await expect(bob.pay(old.bolt11)).rejects.toMatchObject({ code: 'INVOICE_EXPIRED' });
    vi.useRealTimers();
  });

  it('signs with the fake scheme and binds the app key in the invoice description', async () => {
    const net = new FakeLightningNetwork();
    const bob = net.wallet('bob');
    const author = await bob.authorPubkey();
    expect(fakeVerify(author, 'hello', await bob.sign('hello'))).toBe(true);
    const bind = await bob.bindInvoice(author);
    const decoded = await bob.decodeInvoice(bind);
    expect(decoded.description).toBe(`kitty-bind:${sha256Hex(author)}`);
    expect(decoded.payeePubkey).toBe(await bob.nodePubkey());
  });

  it('dave closing a member returns their channel funds on-chain', async () => {
    const net = new FakeLightningNetwork();
    const dave = net.wallet('dave');
    const charlie = net.wallet('charlie');
    const { txids } = await dave.closeChannelsWith(await charlie.nodePubkey());
    expect(txids).toHaveLength(2);
    expect(await charlie.balances()).toEqual({
      tripOutboundCents: 0n,
      inboundCents: 0n,
      onchainCents: 10_000n,
    });
  });

  it('v2: a member closes its own channels with the hub; the hub stops listing them', async () => {
    const net = new FakeLightningNetwork();
    const dave = net.wallet('dave');
    const bob = net.wallet('bob');
    net.wallet('charlie');
    expect((await dave.peerChannels()).map((c) => c.localCents)).toEqual([3000n, 3000n]);
    await bob.closeChannelsWith(await dave.nodePubkey());
    expect(await bob.balances()).toEqual({
      tripOutboundCents: 0n,
      inboundCents: 0n,
      onchainCents: 10_000n,
    });
    expect(await dave.peerChannels()).toHaveLength(1);
    expect(await bob.peerChannels()).toEqual([]);
  });
});

describe('FakeAi', () => {
  it('hears the demo sentence in any recording', async () => {
    const ai = createFakeAi({ delayMs: 0 });
    expect(ai.speechStatus()).toBe('ready');
    expect(await ai.transcribe(new Uint8Array())).toMatchObject({
      ok: true,
      data: { text: DEMO_SENTENCE },
    });
  });

  it('returns the demo dinner, whose ledger split is 3.09 / 3.09 / 3.50', async () => {
    const ai = createFakeAi({ delayMs: 0 });
    const r = await ai.extractReceipt(new Uint8Array());
    if (!r.ok) throw new Error('expected ok');
    z.encode(ReceiptSchema, r.data);
    const s = await ai.proposeSplit(r.data, ['alice', 'bob', 'charlie'], 'whatever');
    expect(s).toMatchObject({ ok: true, data: DEMO_SPLIT });
    const usd = allocateExpense(
      {
        id: 'e1',
        tripId: 'vietnam-2026',
        description: DEMO_RECEIPT.merchant,
        currency: 'VND',
        items: DEMO_RECEIPT.items.map((it, i) => ({
          label: it.label,
          amount: it.total,
          participants: DEMO_SPLIT.assignments.find((a) => a.itemIndex === i)?.members ?? [],
        })),
        extras: { tip: 20_000n },
        total: DEMO_RECEIPT.total,
        payer: 'alice',
        participants: ['alice', 'bob', 'charlie'],
      },
      {
        currency: 'VND',
        value: '26350',
        asOf: '2026-10-17',
        source: 'table',
        lockedAt: '2026-10-17T19:30:00.000Z',
      },
    );
    expect(usd.usdShares.map((x) => x.amount)).toEqual([309n, 309n, 350n]);
  });

  it('fails softly when a demo name is not active (excluded charlie)', async () => {
    const ai = createFakeAi({ delayMs: 0 });
    const s = await ai.proposeSplit(DEMO_RECEIPT, ['alice', 'bob'], 'whatever');
    expect(s.ok).toBe(false);
  });
});
