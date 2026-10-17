import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import type { ActorId, AgentClient, TripView } from '@kitty/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEMO_RECEIPT, DEMO_SPLIT } from '../dev-fakes/fake-ai.js';
import { startStack, waitFor, type Stack } from './harness.js';

// B6 + P1 demo:lose-phone on the regtest stack (SPEC §12, PLAN §4 B6): bob pays, his agent
// backs his node up to the relay; bob loses his phone; a new node restored from the relay has
// the same balance, and a new payment works. IRREVERSIBLE: run `pnpm demo:reset` after.

const repoRoot = fileURLToPath(new URL('../../../../', import.meta.url));
const LOG = process.env.KITTY_E2E_LOG ?? `${repoRoot}infra/.out/logs/e2e-lose-phone-processes.log`;
const execFileP = promisify(execFile);

let stack: Stack;
let api: Record<ActorId, AgentClient>;
const state = (as: ActorId): Promise<TripView> => api[as].getState();
const log = (k: string, v: unknown) =>
  console.log(`[e2e] ${k}: ${JSON.stringify(v, (_, x) => (typeof x === 'bigint' ? `${x}` : x))}`);

async function dinner(photo: string): Promise<string> {
  const e = await api.alice.submitExpense({
    receipt: DEMO_RECEIPT,
    assignments: DEMO_SPLIT.assignments,
    receiptImageSha256: createHash('sha256').update(photo).digest('hex'),
  });
  return e.expenseId;
}

async function bobPaid(expenseId: string): Promise<string> {
  const l = await waitFor(
    `bob pays ${expenseId}`,
    async () => {
      const x = (await state('bob')).me?.debts.find((d) => d.expenseId === expenseId);
      return x?.state === 'paid' ? x : undefined;
    },
    90_000,
  );
  return l.proof?.rail === 'ln' ? l.proof.paymentHash : '';
}

beforeAll(async () => {
  mkdirSync(dirname(LOG), { recursive: true });
  stack = await startStack({
    relayPort: Number(process.env.E2E_RELAY_PORT ?? 4400),
    agentPort: Number(process.env.E2E_AGENT_PORT ?? 4500),
    processLog: LOG,
  });
  api = {
    alice: stack.client('alice'),
    bob: stack.client('bob'),
    charlie: stack.client('charlie'),
    dave: stack.client('dave'),
  };
}, 150_000);

afterAll(async () => {
  await stack?.stop();
});

describe('demo:lose-phone bob on the regtest stack (irreversible)', () => {
  let paidAt = 0;

  it('bob pays 3.09 to alice; his agent then backs his node up to the relay', async () => {
    await bobPaid(await dinner('kitty e2e lose-phone dinner 1'));
    paidAt = Date.now();
    const op = await waitFor(
      "bob's backup after the payment",
      async () =>
        (await state('bob')).operations.find(
          (o) =>
            o.kind === 'backing_up' &&
            o.status === 'done' &&
            Date.parse(o.startedAt) > paidAt - 1_000,
        ),
      60_000,
      1_000,
    );
    log('backup', op);
    expect((await state('bob')).me?.balance?.tripOutboundCents).toBe(4691n);
  });

  it('bob loses his phone: a new node restored from the relay has the same balance', async () => {
    const t0 = Date.now();
    const { stdout } = await execFileP(`${repoRoot}infra/scripts/lose-phone.sh`, ['bob'], {
      cwd: repoRoot,
      env: { ...process.env, RELAY_URL: stack.relayUrl },
      timeout: 180_000,
    });
    log('lose-phone', { ms: Date.now() - t0, tail: stdout.trim().split('\n').slice(-1)[0] });
    expect(stdout).toContain("bob's new phone: same node, 2 channels usable, same balance");
    const b = await waitFor('bob balance from the new node', async () => {
      const x = (await state('bob')).me?.balance;
      return x?.tripOutboundCents === 4691n ? x : undefined;
    });
    log('bob balance', b);
  });

  it('a new payment from the restored node works', async () => {
    const hash = await bobPaid(await dinner('kitty e2e lose-phone dinner 2'));
    const proof = await waitFor('the proof', () => api.bob.getProof({ paymentHash: hash }));
    expect(proof.verified).toBe(true);
    const b = await waitFor('bob at 43.82', async () => {
      const x = (await state('bob')).me?.balance;
      return x?.tripOutboundCents === 4382n ? x : undefined;
    });
    log('bob after the new payment', b);
  });
});
