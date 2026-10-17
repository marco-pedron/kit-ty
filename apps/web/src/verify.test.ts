import {
  DEMO_TRIP_PARAMS,
  GENESIS_HASH,
  StoredEventSchema,
  ed25519PublicKeyHex,
  ed25519Sign,
  signatureVerifier,
  signingMessage,
  storedEventHash,
  type EventInner,
  type StoredEvent,
} from '@kitty/shared';
import { describe, expect, it } from 'vitest';
import { shortHash, verifyLog } from './verify.js';

const SECRET = '01'.repeat(32);
const DAVE = ed25519PublicKeyHex(SECRET);
const AT = '2026-10-17T12:00:00.000Z';

function inner(i: number): EventInner {
  const base = {
    v: 1,
    tripId: 'vietnam-2026',
    author: DAVE,
    nonce: `${i}`.padStart(32, '0'),
    createdAt: AT,
  } as const;
  return i === 1
    ? {
        ...base,
        type: 'TRIP_CREATED',
        body: {
          name: 'Vietnam 2026',
          assetId: 'rgb:dusd',
          params: DEMO_TRIP_PARAMS,
          coordinatorPubkey: DAVE,
        },
      }
    : {
        ...base,
        type: 'RATE_SET',
        body: { asOf: '2026-10-17', source: 'test', rates: { VND: `${26000 + i}` } },
      };
}

/** A chain of n events as the relay sends them (wire form). */
function chain(n: number): unknown[] {
  const out: StoredEvent[] = [];
  for (let i = 1; i <= n; i++) {
    const inn = inner(i);
    const signed = { inner: inn, sig: ed25519Sign(SECRET, signingMessage(inn)) };
    const prevHash = out[i - 2]?.hash ?? GENESIS_HASH;
    out.push({
      seq: i,
      prevHash,
      signed,
      receivedAt: AT,
      hash: storedEventHash({ seq: i, prevHash, signed }),
    });
  }
  return out.map((e) => StoredEventSchema.encode(e));
}

describe('the log verified in the browser', () => {
  it('accepts a well-formed chain with valid signatures', () => {
    const r = verifyLog(chain(3), signatureVerifier);
    expect(r).toMatchObject({ validSignatures: 3, chainValid: true, brokenAt: null, malformed: 0 });
    expect(r.events).toHaveLength(3);
    expect(r.headHash).toBe((chain(3)[2] as { hash: string }).hash);
  });

  it('finds a tampered body: the hash no longer matches', () => {
    const events = chain(3) as { signed: { inner: { body: { source: string } } } }[];
    events[1]!.signed.inner.body.source = 'tampered';
    const r = verifyLog(events, signatureVerifier);
    expect(r.chainValid).toBe(false);
    expect(r.brokenAt).toBe(2);
    expect(r.events[1]).toMatchObject({ linked: false, signatureValid: false });
  });

  it('finds an omitted event and a forged signature', () => {
    const missing = chain(3);
    missing.splice(1, 1);
    expect(verifyLog(missing, signatureVerifier).brokenAt).toBe(3);

    const forged = chain(2) as { signed: { sig: string } }[];
    forged[1]!.signed.sig = ed25519Sign('02'.repeat(32), 'other');
    const r = verifyLog(forged, signatureVerifier);
    expect(r.validSignatures).toBe(1);
    expect(r.events[1]?.linked).toBe(false);
  });

  it('counts what the contract cannot even read', () => {
    const r = verifyLog([...chain(1), { nonsense: true }], signatureVerifier);
    expect(r).toMatchObject({ malformed: 1, chainValid: false, brokenAt: 2 });
  });

  it('with fakes on checks the chain only and says so', () => {
    const r = verifyLog(chain(2), null);
    expect(r).toMatchObject({ chainValid: true, signaturesChecked: false, validSignatures: 0 });
    expect(r.events[0]?.signatureValid).toBeNull();
  });

  it('shortens hashes', () => {
    expect(shortHash('a3f9000000000000c41e')).toBe('a3f9…c41e');
  });
});
