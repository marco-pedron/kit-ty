import { formatCents, type AgentClient, type Check, type ProofView } from '@kitty/shared';
import { Check as CheckIcon, X } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import { cap } from '../../history.js';
import { toClientError } from '../../state.js';
import { NavBar } from '../../ui/Bars.js';
import { Row, Section } from '../../ui/List.js';
import { ErrorNote } from '../../ui/Notes.js';
import { StateView } from '../../ui/Overlays.js';
import { shortHash } from '../../verify.js';
import type { ApiClientError } from '@kitty/shared';

// Proof of a payment (SPEC §10.2, task C6): GET /api/proof/:paymentHash. Three explicit checks
// (preimage ↔ payment hash, invoice signed by the creditor's node, amount); on-chain, the txid
// and the explorer. Right after a payment the proof can be missing for a second (the log has not
// synced yet): the screen keeps asking.

const RETRY_MS = 1000;

export function useProof(client: AgentClient, paymentHash: string) {
  const [proof, setProof] = useState<ProofView | null>(null);
  const [error, setError] = useState<ApiClientError | null>(null);
  const [waiting, setWaiting] = useState(false);
  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = () =>
      client
        .getProof({ paymentHash })
        .then((p) => {
          if (!alive) return;
          setProof(p);
          setError(null);
          setWaiting(false);
        })
        .catch((e: unknown) => {
          if (!alive) return;
          const err = toClientError(e);
          if (err.code === 'NOT_FOUND') {
            setWaiting(true);
            timer = setTimeout(() => void load(), RETRY_MS);
          } else setError(err);
        });
    void load();
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [client, paymentHash]);
  return { proof, error, waiting };
}

export function ProofScreen({
  client,
  paymentHash,
  back,
}: {
  client: AgentClient;
  paymentHash: string;
  back: { label: string; onClick: () => void };
}) {
  const { proof, error, waiting } = useProof(client, paymentHash);
  return (
    <>
      <NavBar title="Proof" back={back} />
      <div className="space-y-6 px-4 pt-4">
        {proof === null ? (
          error !== null ? (
            <ErrorNote error={error} />
          ) : (
            <StateView
              kind="loading"
              title={waiting ? 'Waiting for the proof to reach the log…' : 'Checking the payment…'}
            />
          )
        ) : (
          <ProofBody p={proof} />
        )}
      </div>
    </>
  );
}

function ProofBody({ p }: { p: ProofView }) {
  const checks: Check[] =
    p.rail === 'ln'
      ? [p.checks.preimageMatchesHash, p.checks.invoiceSignedByCreditor, p.checks.amountMatches]
      : [p.checks.txFound, p.checks.amountMatches];
  const by =
    p.rail === 'ln' && p.paidBy === 'guarantee'
      ? 'the operator, for ' + cap(p.debtor)
      : cap(p.debtor);
  return (
    <>
      <div className="text-center">
        <p className="tabular text-large-title font-bold">
          {formatCents(p.cents)}
          <span className="ml-1 text-headline font-normal text-label-2">DUSD</span>
        </p>
        <p className="text-subhead text-label-2">
          From {by} to {cap(p.creditor)}
        </p>
        <p
          className={`mt-2 inline-flex rounded-full px-3 py-1 text-subhead font-semibold ${p.verified ? 'bg-positive text-on-positive' : 'bg-accent-soft text-label'}`}
        >
          {p.verified ? 'Verified ✓' : 'Not verified'}
        </p>
      </div>
      <Section header="Checks" footer="Anyone with the invoice can repeat these checks.">
        {checks.map((c, i) => (
          <CheckRow key={c.label} check={c} last={i === checks.length - 1} />
        ))}
      </Section>
      <Section header="Details">
        {p.rail === 'ln' ? (
          <>
            <Mono label="Payment hash" value={p.paymentHash} />
            <Mono label="Preimage" value={p.preimage} />
            <Mono label="Paid to node" value={p.payeePubkey} last />
          </>
        ) : (
          <>
            <Mono label="Transaction" value={p.txid} />
            <Row
              title="See it on the explorer"
              value={
                <a
                  href={p.explorerUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="text-accent-text"
                >
                  Open
                </a>
              }
              last
            />
          </>
        )}
      </Section>
    </>
  );
}

function CheckRow({ check: c, last }: { check: Check; last: boolean }) {
  return (
    <Row
      leading={
        c.ok ? (
          <span
            className="grid size-[30px] place-items-center rounded-full bg-positive text-on-positive"
            aria-label="verified"
          >
            <CheckIcon size={18} strokeWidth={2.25} />
          </span>
        ) : (
          <span
            className="grid size-[30px] place-items-center rounded-full bg-accent-soft text-accent-text"
            aria-label="failed"
          >
            <X size={18} strokeWidth={2.25} />
          </span>
        )
      }
      title={c.label}
      subtitle={<Wrap>{c.detail}</Wrap>}
      last={last}
    />
  );
}

function Mono({ label, value, last = false }: { label: string; value: string; last?: boolean }) {
  return (
    <Row
      title={label}
      subtitle={
        <span className="font-mono text-footnote" title={value}>
          {shortHash(value)}
        </span>
      }
      value={
        <button
          type="button"
          onClick={() => void navigator.clipboard?.writeText(value)}
          className="pressable min-h-11 px-1 text-subhead text-accent-text"
          aria-label={`Copy ${label}`}
        >
          Copy
        </button>
      }
      last={last}
    />
  );
}

/** Check details can be long (hashes): let them wrap instead of truncating. */
function Wrap({ children }: { children: ReactNode }) {
  return <span className="block whitespace-normal [overflow-wrap:anywhere]">{children}</span>;
}
