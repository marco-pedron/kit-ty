import { checkBindInvoice, PaymentProofSchema, sha256Hex } from '@kitty/shared';
import { beforeAll, describe, expect, it } from 'vitest';
import { LightningRail } from '../rail/lightning-rail.js';
import { WalletError } from './errors.js';
import { RlnWallet } from './rln-wallet.js';
import { loadMemberWalletOptions } from './secrets.js';

// B3 against the real regtest stack seeded by B2: alice creates an invoice, bob pays it through
// dave, the proof is verified. Every payment is undone by one back, so the DUSD balances of the
// seed stay as they were (each payment still moves 3000 sat per hop, spike Q9).
// Run with: pnpm e2e:wallet (needs pnpm infra:up && pnpm demo:unlock).

const URLS = {
  alice: process.env.RLN_ALICE_URL ?? 'http://127.0.0.1:3001',
  bob: process.env.RLN_BOB_URL ?? 'http://127.0.0.1:3002',
};

async function preflight(name: string, url: string): Promise<void> {
  const hint = 'start the stack with `pnpm infra:up && pnpm demo:unlock`';
  let res: Response;
  try {
    res = await fetch(`${url}/nodeinfo`);
  } catch {
    throw new Error(`rln-${name} at ${url} is not reachable: ${hint}`);
  }
  const body = (await res.json().catch(() => null)) as {
    name?: string;
    num_usable_channels?: number;
  } | null;
  if (!res.ok) throw new Error(`rln-${name}: HTTP ${res.status} ${body?.name ?? ''}: ${hint}`);
  if ((body?.num_usable_channels ?? 0) < 2)
    throw new Error(
      `rln-${name} has ${body?.num_usable_channels} usable channels, needs 2: ${hint}`,
    );
}

const errorCode = async (p: Promise<unknown>): Promise<string> =>
  p.then(
    () => 'SUCCEEDED',
    (e: unknown) => (e instanceof WalletError ? e.code : `not a WalletError: ${String(e)}`),
  );

let alice: RlnWallet;
let bob: RlnWallet;

beforeAll(async () => {
  await preflight('alice', URLS.alice);
  await preflight('bob', URLS.bob);
  // Each wallet gets only its own member's options.
  alice = new RlnWallet(loadMemberWalletOptions('alice', { nodeUrl: URLS.alice }));
  bob = new RlnWallet(loadMemberWalletOptions('bob', { nodeUrl: URLS.bob }));
});

describe('RlnWallet on regtest (B3)', () => {
  it('has distinct node and app identities, and a bind invoice other nodes can check', async () => {
    const [aliceNode, bobNode] = [await alice.nodePubkey(), await bob.nodePubkey()];
    expect(aliceNode).not.toBe(bobNode);
    const appPubkey = await alice.authorPubkey();
    expect(appPubkey).not.toBe(await bob.authorPubkey());
    const bolt11 = await alice.bindInvoice(appPubkey);
    const decoded = await bob.decodeInvoice(bolt11);
    expect(decoded.description).toBe(`kitty-bind:${sha256Hex(appPubkey)}`);
    expect(checkBindInvoice(decoded, appPubkey, aliceNode)).toBe(true);
    expect(checkBindInvoice(decoded, appPubkey, bobNode)).toBe(false);
  });

  it('alice requests, bob pays through dave, the proof verifies; then the reverse', async () => {
    const before = { alice: await alice.balances(), bob: await bob.balances() };
    const aliceNode = await alice.nodePubkey();

    const req = await new LightningRail(alice).requestPayment({
      cents: 1n,
      description: 'kitty:b3-integration:pay:bob',
      expirySec: 600,
    });
    if (req.rail !== 'ln') throw new Error('expected a Lightning request');
    const seenByBob = await bob.decodeInvoice(req.bolt11);
    expect(seenByBob.payeePubkey).toBe(aliceNode);
    expect(seenByBob.cents).toBe(1n);

    const t0 = Date.now();
    const proof = await new LightningRail(bob).pay(req);
    const ms = Date.now() - t0;
    if (proof.rail !== 'ln') throw new Error('expected a Lightning proof');
    expect(PaymentProofSchema.safeParse({ ...proof, cents: String(proof.cents) }).success).toBe(
      true,
    );
    expect(sha256Hex(Uint8Array.from(Buffer.from(proof.preimage, 'hex')))).toBe(req.paymentHash);
    expect(proof.paymentHash).toBe(req.paymentHash);
    expect(proof.payeePubkey).toBe(aliceNode);
    expect(proof.cents).toBe(1n);
    console.info(`bob → alice 0.01 settled in ${ms} ms, preimage ${proof.preimage.slice(0, 12)}…`);

    const mid = { alice: await alice.balances(), bob: await bob.balances() };
    expect(mid.alice.tripOutboundCents).toBe(before.alice.tripOutboundCents + 1n);
    expect(mid.bob.tripOutboundCents).toBe(before.bob.tripOutboundCents - 1n);

    // Pay it back so the seed's DUSD balances are untouched.
    const back = await bob.createInvoice({
      cents: 1n,
      description: 'kitty:b3-integration:pay-back:alice',
      expirySec: 600,
    });
    await alice.pay(back.bolt11);
    expect(await alice.balances()).toEqual(before.alice);
    expect(await bob.balances()).toEqual(before.bob);
  });

  it('paying the same invoice again returns the same proof, not a second payment', async () => {
    const inv = await alice.createInvoice({
      cents: 1n,
      description: 'kitty:b3-integration:dup',
      expirySec: 600,
    });
    const first = await bob.pay(inv.bolt11);
    const again = await bob.pay(inv.bolt11);
    expect(again).toEqual(first);
    const back = await bob.createInvoice({
      cents: 1n,
      description: 'kitty:b3-integration:dup-back',
      expirySec: 600,
    });
    await alice.pay(back.bolt11);
  });

  it('refuses an expired invoice before sending', async () => {
    const before = await bob.balances();
    const inv = await alice.createInvoice({
      cents: 1n,
      description: 'kitty:b3-integration:expired',
      expirySec: 1,
    });
    await new Promise((r) => setTimeout(r, 1500));
    expect(await errorCode(bob.pay(inv.bolt11))).toBe('INVOICE_EXPIRED');
    expect(await bob.balances()).toEqual(before);
  });

  it('asks for a top-up when the amount exceeds what bob can send', async () => {
    const { tripOutboundCents } = await bob.balances();
    const inv = await alice.createInvoice({
      cents: tripOutboundCents + 1n,
      description: 'kitty:b3-integration:too-much',
      expirySec: 600,
    });
    expect(await errorCode(bob.pay(inv.bolt11))).toBe('TOPUP_REQUIRED');
    expect((await bob.balances()).tripOutboundCents).toBe(tripOutboundCents);
  });
});
