import { fakeVerifier, sha256Hex } from '@kitty/shared';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
// The real relay, in memory (tests only: apps never import each other).
import { openRelayDb } from '../../../relay/src/db.js';
import { buildRelay } from '../../../relay/src/server.js';
import { DEMO_RECEIPT, DEMO_SPLIT } from '../dev-fakes/fake-ai.js';
import { FakeLightningNetwork } from '../dev-fakes/fake-wallet.js';
import { RelayError } from '../relay/errors.js';
import { createRelayClient } from '../relay/http-client.js';
import { apiErrorOf } from './errors.js';
import { manualClock, setUpTrip } from './test/setup.js';

// A5 over the real wire: the agents talk to apps/relay through C2's RelayClient (HTTP).
// The relay runs its real validateEvent; only the signature scheme and the invoice decoder are
// the fakes', because the wallets are FakeWallets (KITTY_FAKES=1).

beforeEach(() => vi.stubEnv('KITTY_FAKES', '1'));
const running: FastifyInstance[] = [];
afterEach(async () => {
  await Promise.all(running.splice(0).map((a) => a.close()));
  vi.unstubAllEnvs();
});

async function overHttp() {
  const net = new FakeLightningNetwork();
  const { now, advance } = manualClock();
  const relayApp = buildRelay({
    logger: false,
    db: openRelayDb(':memory:'),
    now,
    deps: {
      verify: fakeVerifier,
      decodeInvoice: (bolt11) => {
        const inv = net.invoices.get(bolt11);
        if (inv === undefined) throw new Error('unknown invoice');
        return inv;
      },
    },
  });
  running.push(relayApp);
  const url = await relayApp.listen({ host: '127.0.0.1', port: 0 });
  const relay = createRelayClient({ baseUrl: url, timeoutMs: 5_000 });
  const trip = await setUpTrip({ net, relay, now });
  return { net, relay, now, advance, ...trip };
}

describe('A5 through the real relay and RelayClient (C2)', () => {
  it('steps 2-7 of SPEC §16 end to end over HTTP', async () => {
    const d = await overHttp();
    const { alice, charlie, dave } = d.agents;
    await d.tickAll();

    const e = await alice.submitExpense(DEMO_RECEIPT, DEMO_SPLIT.assignments, sha256Hex('photo'));
    const expenseId = (e.signed.inner.body as { expenseId: string }).expenseId;
    await d.tickAll(); // LINE_SEEN of bob and charlie

    d.advance(5);
    await charlie.decide(expenseId, 'contest', 'I only had water');
    d.advance(5);
    await dave.resolveDispute(expenseId, 'charlie', 'upheld', 'Photo checked with alice');

    d.advance(10); // 20 s after LINE_SEEN: bob's agent pays
    await d.tickAll();
    await d.tickAll();
    d.advance(20); // 30 s after the ruling: charlie is in default
    await d.tickAll();
    expect(dave.trip()?.defaults.map((l) => l.expenseId)).toEqual([expenseId]);

    const result = await dave.coverAndExclude(expenseId, 'charlie');
    expect(result.covered?.rail).toBe('ln');
    await d.tickAll();
    await d.tickAll();

    const lines = [...(alice.trip()?.lines.values() ?? [])];
    expect(lines.map((l) => [l.cents, l.state])).toEqual([
      [309n, 'paid'],
      [350n, 'guaranteed'],
    ]);
    expect(alice.me()?.owedToMeCents).toBe(0n);
    expect((await d.net.wallet('alice').balances()).tripOutboundCents).toBe(5659n);
    expect((await d.net.wallet('bob').balances()).tripOutboundCents).toBe(4691n);
    expect(charlie.me()?.excluded).toBe(true);

    // The relay's chain and every agent's verified copy agree: "uguale su 4/4".
    const relayLog = await d.relay.list();
    const heads = Object.values(d.agents).map((a) => a.log.health());
    expect(heads.every((h) => h.chainValid && h.headHash === relayLog.at(-1)?.hash)).toBe(true);
  });

  it("a relay refusal reaches the caller with the ledger's reason and an action", async () => {
    const d = await overHttp();
    await d.tickAll();
    const e = await d.agents.alice.submitExpense(
      DEMO_RECEIPT,
      DEMO_SPLIT.assignments,
      sha256Hex('photo'),
    );
    const expenseId = (e.signed.inner.body as { expenseId: string }).expenseId;
    await d.tickAll();
    d.advance(20); // silent assent is over: a contest comes too late
    const err = await d.agents.bob
      .decide(expenseId, 'contest', 'too late')
      .catch((x: unknown) => x);
    expect(err).toBeInstanceOf(RelayError);
    expect(apiErrorOf(err)).toMatchObject({
      code: 'INVALID_EVENT',
      message: expect.stringMatching(/due line cannot be contested/),
    });
  });
});
