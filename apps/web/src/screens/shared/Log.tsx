import { signatureVerifier, type MemberView, type StoredEvent } from '@kitty/shared';
import { ShieldAlert, ShieldCheck } from 'lucide-react';
import { useEffect, useState } from 'react';
import { cap } from '../../history.js';
import { NavBar } from '../../ui/Bars.js';
import { Row, Section, Tile } from '../../ui/List.js';
import { StateView } from '../../ui/Overlays.js';
import { shortHash, verifyLog, type LogCheck } from '../../verify.js';

// "Log" (task C6, SPEC §9.5): the relay's events, re-verified here in the browser. With fakes on
// the signatures are forgeable by design, so only the hash chain is checked, and the screen says
// so. "Equal on N/N phones" (checkpoints) is P1 and not shown.

const POLL_MS = 3000;

export function useVerifiedLog(fakes: boolean): { check: LogCheck | null; error: string | null } {
  const [check, setCheck] = useState<LogCheck | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    const load = () =>
      fetch('/relay/events')
        .then((r) => {
          if (!r.ok) throw new Error(`HTTP ${r.status}`);
          return r.json() as Promise<unknown[]>;
        })
        .then((raw) => {
          if (!alive) return;
          setCheck(verifyLog(raw, fakes ? null : signatureVerifier));
          setError(null);
        })
        .catch((e: unknown) => alive && setError(String(e)));
    void load();
    const id = setInterval(() => void load(), POLL_MS);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [fakes]);
  return { check, error };
}

/** The payment a log row proves, if any: its payment hash or txid, for the Proof screen. */
export function proofOf(e: StoredEvent): string | null {
  const { inner } = e.signed;
  if (inner.type === 'PAYMENT_MADE')
    return inner.body.rail === 'ln' ? inner.body.paymentHash : inner.body.txid;
  if (inner.type === 'GUARANTEE_PAID') return inner.body.paymentHash;
  return null;
}

export function LogScreen({
  members,
  fakes,
  back,
  onProof,
}: {
  members: readonly MemberView[];
  fakes: boolean;
  back: { label: string; onClick: () => void };
  onProof: (hash: string) => void;
}) {
  const { check, error } = useVerifiedLog(fakes);
  const names = new Map(members.map((m) => [m.pubkey, cap(m.displayName)]));
  const coordinator = check?.events[0]?.event.signed.inner.author;
  const who = (pubkey: string) =>
    names.get(pubkey) ?? (pubkey === coordinator ? 'Dave' : shortHash(pubkey));

  return (
    <>
      <NavBar title="Log" large back={back} />
      <div className="space-y-6 px-4">
        {check === null ? (
          error === null ? (
            <StateView kind="loading" title="Checking the log on this phone…" />
          ) : (
            <StateView
              kind="error"
              title="The relay is not answering."
              text="Your agent keeps its own copy. The log reappears when the relay is back."
            />
          )
        ) : (
          <>
            <Summary check={check} fakes={fakes} />
            {check.events.length === 0 ? (
              <StateView
                kind="empty"
                title="Nothing signed yet"
                text="Every event of the trip shows here, signed by its author."
              />
            ) : (
              <Section header="Events" footer="Newest first. Tap a payment to see its proof.">
                {[...check.events].reverse().map((v, i, all) => {
                  const e = v.event;
                  const proof = proofOf(e);
                  const ok = v.linked && v.signatureValid !== false;
                  const txids =
                    e.signed.inner.type === 'MEMBER_EXCLUDED'
                      ? e.signed.inner.body.closingTxids
                      : [];
                  return (
                    <Row
                      key={e.seq}
                      title={
                        <span className="font-mono text-subhead">
                          #{e.seq} {e.signed.inner.type}
                        </span>
                      }
                      subtitle={
                        <>
                          {who(e.signed.inner.author)} ·{' '}
                          {new Date(e.receivedAt).toLocaleTimeString('en-GB')}
                          {txids.map((t) => (
                            <span key={t} className="block font-mono text-footnote">
                              closing tx {shortHash(t)}
                            </span>
                          ))}
                        </>
                      }
                      value={
                        <span className={`font-mono text-footnote ${ok ? '' : 'text-accent-text'}`}>
                          {ok ? shortHash(e.hash) : 'not valid'}
                        </span>
                      }
                      chevron={proof !== null}
                      {...(proof !== null && { onClick: () => onProof(proof) })}
                      last={i === all.length - 1}
                    />
                  );
                })}
              </Section>
            )}
          </>
        )}
      </div>
    </>
  );
}

function Summary({ check, fakes }: { check: LogCheck; fakes: boolean }) {
  const n = check.events.length;
  const icon = { size: 18, strokeWidth: 1.75 };
  return (
    <Section
      footer={
        check.headHash === null
          ? undefined
          : `Head ${shortHash(check.headHash)}. ${check.signaturesChecked ? 'Hashes and signatures are' : 'Hashes are'} recomputed on this phone: no one, not even the relay, is trusted.`
      }
    >
      <Row
        leading={
          check.chainValid ? (
            <span className="grid size-[30px] place-items-center rounded-tile bg-positive text-on-positive">
              <ShieldCheck {...icon} />
            </span>
          ) : (
            <Tile tone="accent">
              <ShieldAlert {...icon} />
            </Tile>
          )
        }
        title={check.chainValid ? 'Chain verified ✓' : `Chain broken at #${check.brokenAt ?? '?'}`}
        subtitle={
          check.signaturesChecked
            ? `${n} events · ${check.validSignatures}/${n} signatures valid`
            : `${n} events · hash chain only (fakes)`
        }
        last
      />
      {!check.chainValid && (
        <p className="px-4 pb-3 text-subhead text-label">
          An event does not follow the previous one, or its signature does not match its author.
          Your agent stopped trusting the relay from that point and keeps its own copy.
          {fakes ? '' : ' Tell the coordinator.'}
        </p>
      )}
    </Section>
  );
}
