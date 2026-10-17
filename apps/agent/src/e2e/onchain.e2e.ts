import { describe, expect, it } from 'vitest';
import { OnchainRail } from '../rail/onchain-rail.js';
import { createEsplora, dockerMiner } from '../wallet/chain.js';
import { RlnWallet } from '../wallet/rln-wallet.js';
import { loadMemberWalletOptions } from '../wallet/secrets.js';
import { ESPLORA, waitFor } from './harness.js';

// B5 on the regtest stack (SPEC §10.3): bob pays alice 1.00 DUSD with an on-chain RGB transfer,
// the rail used for an excluded member (no channels). Wallets only, no agents: this transfer is
// not in any trip log. IRREVERSIBLE: run `pnpm demo:reset` after.

const wallet = (actor: 'alice' | 'bob', port: number) =>
  new RlnWallet({
    ...loadMemberWalletOptions(actor, { nodeUrl: `http://127.0.0.1:${port}` }),
    refreshEveryMs: 0,
  });

describe('B5 OnchainRail on the regtest stack (irreversible)', () => {
  it('bob pays alice 1.00 on-chain; the txid is confirmed; alice receives it', async () => {
    const alice = wallet('alice', 3001);
    const bob = wallet('bob', 3002);
    const esplora = createEsplora(ESPLORA);
    const opts = { esplora, miner: dockerMiner, timeoutMs: 90_000 };
    const aliceBefore = await alice.balances();
    const bobBefore = await bob.balances();

    const t0 = Date.now();
    const req = await new OnchainRail(alice, opts).requestPayment({
      cents: 100n,
      description: 'kitty e2e on-chain',
      expirySec: 3600,
    });
    const proof = await new OnchainRail(bob, opts).pay(req);
    console.log(
      `[e2e] paid on-chain: ${JSON.stringify({ ...proof, cents: `${proof.cents}`, ms: Date.now() - t0 })}`,
    );
    expect(proof).toMatchObject({ rail: 'onchain', cents: 100n });
    expect((await esplora.tx(proof.rail === 'onchain' ? proof.txid : ''))?.status.confirmed).toBe(
      true,
    );

    // alice's node imports the consignment at its refresh; then both sides settle
    const a = await waitFor(
      'alice +1.00 on-chain',
      async () => {
        const b = await alice.balances();
        return b.onchainCents === aliceBefore.onchainCents + 100n ? b : undefined;
      },
      90_000,
      2_000,
    );
    await waitFor(
      "bob's transfer Settled",
      async () =>
        (await bob.rgbTransferStatus({ send: proof.rail === 'onchain' ? proof.txid : '' })) ===
        'Settled'
          ? true
          : undefined,
      90_000,
      2_000,
    );
    const b = await bob.balances();
    console.log(
      `[e2e] balances: alice ${a.onchainCents} (was ${aliceBefore.onchainCents}), bob ${b.onchainCents} (was ${bobBefore.onchainCents})`,
    );
    expect(b.onchainCents).toBe(bobBefore.onchainCents - 100n);
    // the channels are untouched
    expect(a.tripOutboundCents).toBe(aliceBefore.tripOutboundCents);
    expect(b.tripOutboundCents).toBe(bobBefore.tripOutboundCents);
  });
});
