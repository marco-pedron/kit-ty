import {
  GENESIS_HASH,
  StoredEventSchema,
  signingMessage,
  storedEventHash,
  type SignatureVerifier,
  type StoredEvent,
} from '@kitty/shared';

// "Chain verified" (SPEC §9.4-9.5, task C6), computed in the browser: nobody, not even the
// relay or this phone's agent, is trusted. For every event of the relay: the contract's schema,
// seq + 1, prevHash = previous hash, hash = sha256(canonical({ seq, prevHash, signed })), and the
// author's signature on canonical(inner).

export interface VerifiedEvent {
  event: StoredEvent;
  /** The relay's hash is the one recomputed here, and it follows the previous one. */
  linked: boolean;
  /** null when signatures are not checked (fakes on: fake signatures are forgeable by design). */
  signatureValid: boolean | null;
}

export interface LogCheck {
  events: VerifiedEvent[];
  validSignatures: number;
  /** false with fakes on: only the hash chain is checked. */
  signaturesChecked: boolean;
  chainValid: boolean;
  /** seq of the first event that breaks the chain; null when the chain holds. */
  brokenAt: number | null;
  /** Wire events the contract rejects (not even decodable). */
  malformed: number;
  headHash: string | null;
}

/** `verifier` null = fakes on: the chain is checked, signatures are reported as simulated. */
export function verifyLog(raw: readonly unknown[], verifier: SignatureVerifier | null): LogCheck {
  const events: VerifiedEvent[] = [];
  let malformed = 0;
  let prev: StoredEvent | null = null;
  let brokenAt: number | null = null;
  for (const r of raw) {
    const parsed = StoredEventSchema.safeDecode(r as never);
    if (!parsed.success) {
      malformed += 1;
      brokenAt ??= prev === null ? 1 : prev.seq + 1;
      continue;
    }
    const e = parsed.data;
    const expectedSeq = prev === null ? 1 : prev.seq + 1;
    const expectedPrev = prev === null ? GENESIS_HASH : prev.hash;
    const linked =
      e.seq === expectedSeq && e.prevHash === expectedPrev && storedEventHash(e) === e.hash;
    let signatureValid: boolean | null = null;
    if (verifier !== null)
      try {
        signatureValid = verifier.verify(
          e.signed.inner.author,
          signingMessage(e.signed.inner),
          e.signed.sig,
        );
      } catch {
        signatureValid = false;
      }
    if (!linked || signatureValid === false) brokenAt ??= e.seq;
    events.push({ event: e, linked, signatureValid });
    prev = e;
  }
  return {
    events,
    validSignatures: events.filter((v) => v.signatureValid === true).length,
    signaturesChecked: verifier !== null,
    chainValid: brokenAt === null && malformed === 0,
    brokenAt,
    malformed,
    headHash: prev?.hash ?? null,
  };
}

/** "a3f9…c41e". */
export const shortHash = (h: string) => (h.length <= 10 ? h : `${h.slice(0, 4)}…${h.slice(-4)}`);
