import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEMO_RECEIPT, DEMO_SPLIT } from '../dev-fakes/fake-ai.js';
import { sha256Hex, type ActorId } from '@kitty/shared';
import { demo, type Demo } from './test/setup.js';

// B6, SPEC §12: each agent backs its node up to the relay once the node has been quiet for
// backupQuietMs after a change it can see in the log (or made itself).

beforeEach(() => vi.stubEnv('KITTY_FAKES', '1'));
afterEach(() => vi.unstubAllEnvs());

const ACTORS: ActorId[] = ['alice', 'bob', 'charlie', 'dave'];

/** The version of the latest backup of each node on the relay ("fake-N"), or null. */
async function versions(d: Demo): Promise<Record<string, string | null>> {
  const out: Record<string, string | null> = {};
  for (const a of ACTORS) {
    const blob = await d.relay.getBackup(await d.net.wallet(a).nodePubkey());
    out[a] = blob === null ? null : new TextDecoder().decode(blob);
  }
  return out;
}

describe('automatic backups (B6)', () => {
  it('after the setup, then only for the nodes a change touched, after 10 s of quiet', async () => {
    const d = await demo({ backupQuietMs: 10_000 });
    await d.tickAll();
    expect(await versions(d)).toEqual({ alice: null, bob: null, charlie: null, dave: null });

    // the channels of the setup: everyone, once quiet
    d.advance(10);
    await d.tickAll();
    const first = { alice: 'fake-1', bob: 'fake-1', charlie: 'fake-1', dave: 'fake-1' };
    expect(await versions(d)).toEqual(first);
    expect(d.agents.bob.operations()[0]).toMatchObject({ kind: 'backing_up', status: 'done' });
    await d.tickAll();
    expect(await versions(d)).toEqual(first); // nothing changed since

    // alice's invoices: only alice's node changed
    await d.agents.alice.submitExpense(DEMO_RECEIPT, DEMO_SPLIT.assignments, sha256Hex('photo'));
    await d.tickAll();
    d.advance(5);
    await d.tickAll();
    expect((await versions(d)).alice).toBe('fake-1'); // not quiet yet
    d.advance(5);
    await d.tickAll();
    expect(await versions(d)).toEqual({ ...first, alice: 'fake-2' });

    // silent assent: bob and charlie pay alice through dave; all four nodes changed. Each agent
    // sees the PAYMENT_MADE at its next tick, and the quiet period starts there.
    d.advance(10); // seen at t = 10, silent assent ends at t = 30
    await d.tickAll();
    await d.tickAll();
    d.advance(10);
    await d.tickAll();
    expect(await versions(d)).toEqual({
      alice: 'fake-3',
      bob: 'fake-2',
      charlie: 'fake-2',
      dave: 'fake-2',
    });
  });

  it('a failed backup is retried after retryMs', async () => {
    const d = await demo({ backupQuietMs: 10_000, retryMs: 10_000 });
    const bobNode = await d.net.wallet('bob').nodePubkey();
    const put = d.relay.putBackup.bind(d.relay);
    let failed = 0;
    const spy = vi.spyOn(d.relay, 'putBackup').mockImplementation(async (pubkey, blob) => {
      if (pubkey === bobNode && failed++ === 0) throw new Error('relay down');
      return put(pubkey, blob);
    });
    const bobCalls = () => spy.mock.calls.filter(([pk]) => pk === bobNode).length;
    await d.tickAll();
    d.advance(10);
    await d.tickAll();
    expect(d.agents.bob.operations()[0]).toMatchObject({ kind: 'backing_up', status: 'failed' });
    d.advance(5);
    await d.tickAll();
    expect(bobCalls()).toBe(1);
    d.advance(5);
    await d.tickAll();
    expect(bobCalls()).toBe(2);
    expect(d.agents.bob.operations()[0]).toMatchObject({ kind: 'backing_up', status: 'done' });
  });
});
