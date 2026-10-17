import { secp256k1 } from '@noble/curves/secp256k1.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { describe, expect, it } from 'vitest';
import { assetIdFromBytes, assetIdToBytes, Bolt11Error, decodeBolt11 } from './bolt11.js';
import { encodeBolt11, tamper } from './test/bolt11-encode.js';

// A real RGB invoice from rgb-lightning-node and the node's own /decodelninvoice of it
// (spikes/wdk/calls.log:78-79): the decoder must read exactly the same fields.
const REAL_INVOICE =
  'lnbcrt30u1p4dyt9ddqqnp4qgm5fapdav3gsvgfhx3vyuc6r3drh6mfdjuta5g0267e3dt6ukfnspp5p439xhdpeedm67kch9harptnddqyj098p30tdjxhe5ycz85vplvqsp5nssn3rnccjvxt4e08yree7vexrswnl7p29np2lpet4g26gcej56q9qyysgqcqzp2xqrrsslp5avj7dqgm892k2ghxek3cv67kp4phmkwynu5nkadqkmshkagmqkvq7qzf4n54ywzljxsvx8r873qtzz0yacm8hh8vg5glx3jrdmea82q6a7z3kynk5x5r0u7ehx5qjq7x0nwleyap8yhg5swzuvv4qkyg4d3un3ggqg4tejq';
const NODE_DECODE = {
  amt_msat: 3000000,
  expiry_sec: 3600,
  timestamp: 1792158893,
  asset_id: 'rgb:6yXmgRs5-VWUi5s2-jhmvWDU-N92cSfK-Tt1oLbh-e3UbBZg',
  asset_amount: 309,
  payment_hash: '0d62535da1ce5bbd7ad8b96fd185736b40493ca70c5eb6c8d7cd09811e8c0fd8',
  payee_pubkey: '023744f42deb22883109b9a2c2731a1c5a3beb696cb8bed10f56bd98b57ae59338',
};

const nodeSecret = secp256k1.utils.randomSecretKey();
const nodePub = bytesToHex(secp256k1.getPublicKey(nodeSecret));
const otherSecret = secp256k1.utils.randomSecretKey();
const ASSET = 'rgb:CJkb4YZw-jRiz2sk-~PARPio-wtVYI1c-XAEYCqO-wTfvRZ8';
const base = {
  nodeSecret,
  timestampSec: 1792158893,
  paymentHash: new Uint8Array(32).fill(0xab),
  description: 'kitty:vietnam-2026:e1:bob',
  assetId: ASSET,
  assetAmount: 309n,
};

describe('decodeBolt11 on a real rgb-lightning-node invoice', () => {
  it('reads the same fields as /decodelninvoice', () => {
    expect(decodeBolt11(REAL_INVOICE)).toEqual({
      bolt11: REAL_INVOICE,
      payeePubkey: NODE_DECODE.payee_pubkey,
      paymentHash: NODE_DECODE.payment_hash,
      assetId: NODE_DECODE.asset_id,
      cents: BigInt(NODE_DECODE.asset_amount),
      amtMsat: BigInt(NODE_DECODE.amt_msat),
      description: '',
      expiresAt: new Date((NODE_DECODE.timestamp + NODE_DECODE.expiry_sec) * 1000).toISOString(),
    });
  });

  it('accepts it in upper case, rejects it with one character changed', () => {
    expect(decodeBolt11(REAL_INVOICE.toUpperCase()).paymentHash).toBe(NODE_DECODE.payment_hash);
    expect(() => decodeBolt11(tamper(REAL_INVOICE))).toThrow(/checksum/);
  });
});

describe('baid64 asset ids (baid64 crate 0.4.1, as in RLN d4762ac)', () => {
  it('maps _ to 62 and ~ to 63', () => {
    // 0xfb 0xef 0xbe = 111110 111110 111110 111110: four sextets of 62.
    const b62 = Uint8Array.from({ length: 32 }, (_, i) => [0xfb, 0xef, 0xbe][i % 3]!);
    expect(assetIdFromBytes(b62)).toMatch(/^rgb:_{8}-_{7}/);
    expect(assetIdFromBytes(new Uint8Array(32).fill(0xff))).toMatch(/^rgb:~{8}-~{7}/);
    expect(assetIdFromBytes(new Uint8Array(32))).toBe(
      'rgb:AAAAAAAA-AAAAAAA-AAAAAAA-AAAAAAA-AAAAAAA-AAAAAAA',
    );
  });

  it('round-trips ids that contain _ and ~', () => {
    for (const id of [
      ASSET,
      'rgb:ZfUYO5Cr-Rp_3oXd-eZZwd54-zLGX3Js-3liqx0G-D~eGyvQ',
      'rgb:R5io89Ca-DzfwBhc-TJwGXw9-GPd4Bax-BDBs7Kq-Kgrbe~I',
      NODE_DECODE.asset_id,
    ]) {
      expect(assetIdFromBytes(assetIdToBytes(id))).toBe(id);
    }
    for (let i = 0; i < 200; i++) {
      const bytes = secp256k1.utils.randomSecretKey();
      expect(assetIdToBytes(assetIdFromBytes(bytes))).toEqual(bytes);
    }
  });

  it('rejects malformed ids', () => {
    expect(() => assetIdToBytes('CJkb4YZw-jRiz2sk-~PARPio-wtVYI1c-XAEYCqO-wTfvRZ8')).toThrow();
    expect(() => assetIdToBytes('rgb:CJkb4YZw')).toThrow(/43/);
    expect(() => assetIdToBytes(`${ASSET.slice(0, -1)}+`)).toThrow(/baid64 character/);
    // Last character carries 4 bits + 2 padding bits that must be zero.
    expect(() => assetIdToBytes(`${ASSET.slice(0, -1)}9`)).toThrow(/non-canonical/);
  });
});

describe('decodeBolt11 on generated invoices', () => {
  it('reads every field', () => {
    const inv = encodeBolt11(base);
    expect(decodeBolt11(inv)).toEqual({
      bolt11: inv,
      payeePubkey: nodePub,
      paymentHash: 'ab'.repeat(32),
      assetId: ASSET,
      cents: 309n,
      amtMsat: 3_000_000n,
      description: 'kitty:vietnam-2026:e1:bob',
      expiresAt: new Date((1792158893 + 3600) * 1000).toISOString(),
    });
  });

  it('recovers the payee when the n field is absent', () => {
    expect(decodeBolt11(encodeBolt11({ ...base, payee: null })).payeePubkey).toBe(nodePub);
  });

  it('rejects an invoice signed by a node other than the payee it names (SPEC §13 #1)', () => {
    const forged = encodeBolt11({
      ...base,
      nodeSecret: otherSecret,
      payee: secp256k1.getPublicKey(nodeSecret),
    });
    expect(() => decodeBolt11(forged)).toThrow(/signature does not match the payee/);
  });

  it('reads plain BTC invoices, amounts in every unit, and the default expiry', () => {
    const plain = decodeBolt11(
      encodeBolt11({ ...base, assetId: undefined, assetAmount: undefined, hrp: 'lnbcrt' }),
    );
    expect(plain).toMatchObject({ assetId: null, cents: null, amtMsat: null });
    const msat = (hrp: string) => decodeBolt11(encodeBolt11({ ...base, hrp })).amtMsat;
    expect(msat('lnbcrt1m')).toBe(100_000_000n);
    expect(msat('lnbcrt30u')).toBe(3_000_000n);
    expect(msat('lnbcrt25n')).toBe(2_500n);
    expect(msat('lnbcrt10p')).toBe(1n);
    expect(msat('lnbcrt1')).toBe(100_000_000_000n);
    expect(() => msat('lnbcrt15p')).toThrow(/whole number of msat/);
  });

  it('accepts only regtest invoices (CLAUDE.md rule 9)', () => {
    for (const hrp of ['lnbc30u', 'lntb30u', 'lntbs30u', 'lnsb30u']) {
      expect(() => decodeBolt11(encodeBolt11({ ...base, hrp }))).toThrow(/regtest only/);
    }
  });

  it('rejects repeated fields, a lone asset field and a missing payment hash', () => {
    expect(() => decodeBolt11(encodeBolt11({ ...base, extra: [[30, [1]]] }))).toThrow(/repeated/);
    expect(() => decodeBolt11(encodeBolt11({ ...base, assetId: undefined }))).toThrow(/together/);
    // A p field of the wrong length is skipped (BOLT11), so the invoice has no payment hash.
    const short = encodeBolt11({ ...base, paymentHash: new Uint8Array(31) });
    expect(() => decodeBolt11(short)).toThrow(/no payment hash/);
  });

  it('throws Bolt11Error on garbage', () => {
    for (const s of ['', 'hello', 'lnbcrt1qqqqqq', 'lnbcrt30u1' + 'q'.repeat(200)]) {
      expect(() => decodeBolt11(s)).toThrow(Bolt11Error);
    }
  });
});
