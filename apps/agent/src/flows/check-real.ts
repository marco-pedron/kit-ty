import { sha256Hex } from '@kitty/shared';
import { loadConfig } from '../config.js';
// Only the demo dinner and its split (plain data): no fake is built here.
import { DEMO_RECEIPT, DEMO_SPLIT } from '../dev-fakes/fake-ai.js';
import { createRelayClient } from '../relay/http-client.js';
import { realSetup } from './real-setup.js';
import { seedTrip, startAgents } from './runtime.js';

// A5 ★3 by hand, on the real regtest stack (task B runs it, not CI):
//   pnpm demo:unlock                                  # or pnpm demo:reset
//   RELAY_DB=':memory:' pnpm --filter @kitty/relay start
//   pnpm --filter @kitty/agent exec tsx src/flows/check-real.ts
// The same agents as index.ts on the real RLN nodes: the trip is set up from the seed, alice
// submits the dinner, charlie contests, bob's agent pays 3.09 over Lightning after the silent
// assent. Checks the proof and the DUSD moved on the nodes. A REAL payment: bob ends at 46.91,
// as after step 3 of the demo; run pnpm demo:reset before the demo.

const t0 = Date.now();
const step = (msg: string) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)} s] ${msg}`);
const fail = (msg: string): never => {
  console.error(`FAIL: ${msg}`);
  process.exit(1);
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const config = loadConfig();
if (config.KITTY_FAKES) fail('unset KITTY_FAKES: this check runs on the real nodes');
const { wallets, seed } = realSetup(config);
const log = { info: step, warn: (m: string) => step(`warn: ${m}`) };
const rt = startAgents({
  fakes: false,
  relay: createRelayClient({ baseUrl: config.RELAY_URL }),
  wallets,
  log,
});
const agent = (id: 'alice' | 'bob' | 'charlie') => rt.agents.get(id)!;

try {
  step(`relay ${config.RELAY_URL}, asset ${seed.assetId}`);
  await seedTrip(rt, seed, log);
  for (const a of rt.agents.values()) await a.sync();

  const before = { alice: await wallets.alice.balances(), bob: await wallets.bob.balances() };
  step(
    `balances before: alice out ${before.alice.tripOutboundCents}, bob out ${before.bob.tripOutboundCents}`,
  );

  // A fresh photo hash each run, so a second run is not a duplicate receipt (SPEC §13 #5).
  const photo = sha256Hex(`check-real ${new Date().toISOString()}`);
  const e = await agent('alice').submitExpense(DEMO_RECEIPT, DEMO_SPLIT.assignments, photo);
  const expenseId = (e.signed.inner.body as { expenseId: string }).expenseId;
  step(`alice submitted the dinner, expense ${expenseId} (seq ${e.seq})`);

  const lineOf = (id: 'bob' | 'charlie') => {
    const pk = agent(id).me()?.pubkey;
    return [...(agent('alice').trip()?.lines.values() ?? [])].find(
      (l) => l.expenseId === expenseId && l.debtorPubkey === pk,
    );
  };
  for (let i = 0; lineOf('charlie')?.state !== 'awaiting_decision'; i++) {
    if (i > 20) fail('charlie never saw the expense (LINE_SEEN)');
    await sleep(500);
  }
  await agent('charlie').decide(expenseId, 'contest', 'I only had water');
  step('charlie contested his line');

  step('waiting for the silent assent of bob (SILENT_ASSENT_SECONDS) and the payment…');
  for (let i = 0; lineOf('bob')?.state !== 'paid'; i++) {
    if (i > 120) fail(`bob's line is ${lineOf('bob')?.state ?? 'missing'} after 60 s`);
    await sleep(500);
  }
  await agent('bob').idle();
  const line = lineOf('bob')!;
  const p = line.payment as { paymentHash: string; preimage: string; at: Date };
  step(`bob's agent paid ${line.cents} cents: PAYMENT_MADE at ${p.at.toISOString()}`);

  // The proof, as the panel of SPEC §10.2 checks it.
  const inv = await wallets.alice.decodeInvoice(line.bolt11);
  const preimageOk = sha256Hex(Buffer.from(p.preimage, 'hex')) === p.paymentHash;
  const hashOk = inv.paymentHash === p.paymentHash;
  const payeeOk = inv.payeePubkey === (await wallets.alice.nodePubkey());
  step(
    `proof: sha256(preimage) = paymentHash ${preimageOk}, hash of alice's invoice ${hashOk}, payee = alice's node ${payeeOk}`,
  );
  if (!preimageOk || !hashOk || !payeeOk) fail('the proof does not verify');

  const after = { alice: await wallets.alice.balances(), bob: await wallets.bob.balances() };
  step(
    `balances after:  alice out ${after.alice.tripOutboundCents}, bob out ${after.bob.tripOutboundCents}`,
  );
  if (before.bob.tripOutboundCents - after.bob.tripOutboundCents !== line.cents)
    fail('bob did not send exactly the line amount');
  if (after.alice.tripOutboundCents - before.alice.tripOutboundCents !== line.cents)
    fail('alice did not receive exactly the line amount');

  for (const a of rt.agents.values()) await a.sync();
  const health = [...rt.agents].map(([id, a]) => ({
    id,
    ...a.log.health(),
    div: a.log.divergence,
  }));
  for (const h of health)
    step(
      `${h.id.padEnd(8)} events ${h.events}, signatures ${h.validSignatures}/${h.events}, chain ${h.chainValid}, head ${h.headHash?.slice(0, 12)}`,
    );
  if (health.some((h) => h.div !== null || !h.chainValid)) fail('an agent rejected the relay log');
  if (new Set(health.map((h) => h.headHash)).size !== 1) fail('the agents have different heads');

  step('OK: real Lightning payment, proof verified, same log on 4/4 agents');
} finally {
  rt.stop();
}
process.exit(0);
