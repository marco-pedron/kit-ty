// node --test src/swap-verify.test.ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { lnDeadlineBound, NUMS_XONLY, verifySwap, type SwapExpectation, type SwapObservation } from './swap-verify.ts';

const H = 'aa'.repeat(32);
const SPK = '5120' + 'bb'.repeat(32);
const exp: SwapExpectation = {
  assetId: 'rgb:asset',
  amount: 5000,
  travelerNodePubkey: '02traveler',
  travelerRefundKey: 'refundkey',
  daveClaimKey: 'davekey',
  timeout: 1300,
  finalCltvDelta: 42,
  maxShadowCltv: 216,
  marginBlocks: 72,
};
function obs(over: Partial<SwapObservation> = {}): SwapObservation {
  return {
    currentHeight: 1002,
    invoice: { paymentHash: H, assetId: 'rgb:asset', assetAmount: 5000, payeePubkey: '02traveler', minFinalCltvExpiryDelta: 42, expiresAt: 2000 },
    announced: { hash: H, claim: 'davekey', refund: 'refundkey', timeout: 1300 },
    expected: { scriptPubkey: SPK, internalKey: NUMS_XONLY },
    lockOutput: { scriptPubkey: SPK, valueSat: 1000, confirmations: 1 },
    consignment: { accepted: true, assetId: 'rgb:asset', amount: 5000 },
    nowSec: 1000,
    ...over,
  };
}
const fails = (o: SwapObservation, x = exp) => verifySwap(x, o).failures;

test('a correct swap is paid', () => {
  const v = verifySwap(exp, obs());
  assert.equal(v.pay, true, v.failures.join('; '));
  assert.equal(v.lnDeadlineBound, 1002 + 1 + 42 + 216 - 39);
});
test('deadline bound matches the stage 1 measurement', () => {
  // paid at 113 on a graph of one 72-delta channel: shadow 72+40+40 = 152, cltv_expiry 308, deadline 269
  assert.equal(lnDeadlineBound(113, 42, 152), 269);
});
test('lock only in mempool', () => assert.match(fails(obs({ lockOutput: { scriptPubkey: SPK, valueSat: 1000, confirmations: 0 } })).join(), /not confirmed/));
test('no lock output', () => assert.match(fails(obs({ lockOutput: null })).join(), /not found/));
test('lower amount: consignment rejected by the wallet', () =>
  assert.match(fails(obs({ consignment: { accepted: false, error: 'expected Fungible(5000)' } })).join(), /consignment not accepted/));
test('lower amount: consignment amount', () =>
  assert.match(fails(obs({ consignment: { accepted: true, assetId: 'rgb:asset', amount: 4000 } })).join(), /amount 4000/));
test('other asset', () => assert.match(fails(obs({ consignment: { accepted: true, assetId: 'rgb:other', amount: 5000 } })).join(), /asset rgb:other/));
test('different hash: announced and script', () => {
  const f = fails(obs({ announced: { hash: 'cc'.repeat(32), claim: 'davekey', refund: 'refundkey', timeout: 1300 }, lockOutput: { scriptPubkey: '5120' + 'dd'.repeat(32), valueSat: 1000, confirmations: 1 } }));
  assert.ok(f.some((m) => /hash ≠ invoice/.test(m)) && f.some((m) => /script differs/.test(m)));
});
test('claim key not dave', () => assert.match(fails(obs({ announced: { hash: H, claim: 'mallory', refund: 'refundkey', timeout: 1300 } })).join(), /claim key is not dave/));
test('refund key not the traveler', () => assert.match(fails(obs({ announced: { hash: H, claim: 'davekey', refund: 'other', timeout: 1300 } })).join(), /refund key/));
test('timeout differs from the agreed T', () => assert.match(fails(obs({ announced: { hash: H, claim: 'davekey', refund: 'refundkey', timeout: 1299 } })).join(), /≠ agreed T/));
test('T too close', () => assert.match(fails(obs(), { ...exp, timeout: 1002 + 220 + 71 }).join(), /T too close/));
test('T just far enough', () => assert.equal(verifySwap({ ...exp, timeout: 1002 + 220 + 72 }, obs({ announced: { hash: H, claim: 'davekey', refund: 'refundkey', timeout: 1002 + 220 + 72 } })).pay, true));
test('internal key not NUMS', () => assert.match(fails(obs({ expected: { scriptPubkey: SPK, internalKey: 'ee'.repeat(32) } })).join(), /NUMS/));
test('script mismatch alone', () => assert.match(fails(obs({ lockOutput: { scriptPubkey: '5120' + 'ff'.repeat(32), valueSat: 1000, confirmations: 3 } })).join(), /script differs/));
test('invoice for less', () => assert.match(fails(obs({ invoice: { ...obs().invoice, assetAmount: 4999 } })).join(), /invoice amount/));
test('invoice to another node', () => assert.match(fails(obs({ invoice: { ...obs().invoice, payeePubkey: '02other' } })).join(), /payee/));
test('invoice with another final CLTV delta', () => assert.match(fails(obs({ invoice: { ...obs().invoice, minFinalCltvExpiryDelta: 144 } })).join(), /final CLTV/));
test('expired invoice', () => assert.match(fails(obs({ nowSec: 3000 })).join(), /expired/));
