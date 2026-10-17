import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { WalletError } from './errors.js';
import { CLOSE_BLOCK_BUDGET, RlnWallet } from './rln-wallet.js';
import { loadMemberWalletOptions } from './secrets.js';

// B7 against the real regtest stack, as in demo step 6 (SPEC §16): dave closes both channels
// with charlie, cooperatively; the DUSD come back to charlie on-chain after the sweep.
// IRREVERSIBLE: afterwards charlie has no channels until `pnpm demo:reset`.
// Run with: pnpm e2e:close (needs pnpm infra:up && pnpm demo:unlock).

const URLS = {
  bob: process.env.RLN_BOB_URL ?? 'http://127.0.0.1:3002',
  charlie: process.env.RLN_CHARLIE_URL ?? 'http://127.0.0.1:3003',
  dave: process.env.RLN_DAVE_URL ?? 'http://127.0.0.1:3004',
};
const SUMMARY = fileURLToPath(new URL('../../../../infra/.out/e2e-close.json', import.meta.url));
const summary: Record<string, unknown> = {};
const note = (k: string, v: unknown) => {
  summary[k] = v;
  mkdirSync(dirname(SUMMARY), { recursive: true });
  writeFileSync(
    SUMMARY,
    JSON.stringify(summary, (_, x) => (typeof x === 'bigint' ? `${x}` : x), 2),
  );
};
const ESPLORA = (process.env.ESPLORA_URL ?? 'http://127.0.0.1:3010').replace(/\/+$/u, '');

type Chan = { peer_pubkey: string; is_usable: boolean; asset_local_amount?: number | null };
const channelsOf = async (url: string): Promise<Chan[]> =>
  ((await (await fetch(`${url}/listchannels`)).json()) as { channels: Chan[] }).channels;

async function waitFor<T>(what: string, f: () => Promise<T | undefined>, ms = 60_000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await f();
    if (v !== undefined) return v;
    if (Date.now() > end) throw new Error(`timeout waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 1000));
  }
}

let bob: RlnWallet;
let charlie: RlnWallet;
let dave: RlnWallet;
let charlieNode: string;
let daveNode: string;
let charlieBack: bigint;
let daveBack: bigint;

beforeAll(async () => {
  const hint = 'run `pnpm infra:up && pnpm demo:unlock` (or `pnpm demo:reset` after a close)';
  // Each wallet gets only its own member's options; only dave's can close.
  bob = new RlnWallet(loadMemberWalletOptions('bob', { nodeUrl: URLS.bob }));
  charlie = new RlnWallet({
    ...loadMemberWalletOptions('charlie', { nodeUrl: URLS.charlie }),
    refreshEveryMs: 0,
  });
  dave = new RlnWallet({
    ...loadMemberWalletOptions('dave', { nodeUrl: URLS.dave }),
    refreshEveryMs: 0,
  });
  charlieNode = await charlie.nodePubkey().catch(() => {
    throw new Error(`rln-charlie not reachable: ${hint}`);
  });
  daveNode = await dave.nodePubkey();
  // Preflight: the 2 channels of the seed between charlie and dave, both usable.
  const withDave = (await channelsOf(URLS.charlie)).filter((c) => c.peer_pubkey === daveNode);
  if (withDave.length !== 2 || !withDave.every((c) => c.is_usable))
    throw new Error(`charlie has ${withDave.length} channels with dave, needs 2 usable: ${hint}`);
  charlieBack = BigInt(withDave.reduce((s, c) => s + (c.asset_local_amount ?? 0), 0));
  const daveSide = (await channelsOf(URLS.dave)).filter((c) => c.peer_pubkey === charlieNode);
  daveBack = BigInt(daveSide.reduce((s, c) => s + (c.asset_local_amount ?? 0), 0));
});

describe('B7 closeChannelsWith on the regtest stack (charlie, irreversible)', () => {
  it("is refused on bob's wallet", async () => {
    const err = await bob.closeChannelsWith(charlieNode).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(WalletError);
    expect((err as WalletError).code).toBe('NOT_ALLOWED');
  });

  it('dave closes both channels with charlie; the DUSD come back on-chain', async () => {
    const charlieBefore = await charlie.balances();
    const daveBefore = await dave.balances();
    note('before', { charlie: charlieBefore, dave: daveBefore, charlieBack, daveBack });

    const t0 = Date.now();
    const r = await dave.closeChannelsWith(charlieNode);
    note('close', { ...r, ms: Date.now() - t0 });

    expect(r.txids).toHaveLength(2);
    expect(r.swept).toBe(true);
    expect(r.blocksMined).toBeLessThanOrEqual(CLOSE_BLOCK_BUDGET);
    for (const [i, t] of r.txids.entries()) {
      expect(r.explorerUrls[i]).toBe(`${ESPLORA}/tx/${t}`);
      const res = await fetch(r.explorerUrls[i] ?? '');
      expect(res.status).toBe(200);
      expect(((await res.json()) as { status: { confirmed: boolean } }).status.confirmed).toBe(
        true,
      );
    }
    expect((await channelsOf(URLS.dave)).some((c) => c.peer_pubkey === charlieNode)).toBe(false);

    // charlie's own wallet sees his DUSD on-chain, after its /refreshtransfers
    const after = await waitFor('charlie settled', async () => {
      const b = await charlie.balances();
      return b.onchainCents === charlieBefore.onchainCents + charlieBack ? b : undefined;
    });
    expect(after).toEqual({
      tripOutboundCents: 0n,
      inboundCents: 0n,
      onchainCents: charlieBefore.onchainCents + charlieBack,
    });
    const daveAfter = await waitFor('dave settled', async () => {
      const b = await dave.balances();
      return b.onchainCents === daveBefore.onchainCents + daveBack ? b : undefined;
    });
    note('after', { charlie: after, dave: daveAfter, at: new Date().toISOString() });
  });

  it('a second close finds nothing to close', async () => {
    const err = await dave.closeChannelsWith(charlieNode).catch((e: unknown) => e);
    expect((err as WalletError).code).toBe('NOT_FOUND');
  });
});
