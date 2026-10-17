import { formatCents, type ApiClientError, type LineView } from '@kitty/shared';
import { useState, type ReactNode } from 'react';
import { Avatar, EmptyState, ErrorBox } from '../components.js';
import {
  canApprove,
  canDispute,
  formatCountdown,
  needsMe,
  secondsLeft,
  transactionRows,
  type TransactionRow,
} from '../lines.js';
import { toClientError, useNow } from '../state.js';
import type { ScreenProps } from './types.js';

// The history of a group as transaction rows (avatar, name, what for, + or − amount, date and
// time), seen by the member. Parts waiting for me come first, as cards with Dispute and Approve.

export function GroupHistory(props: ScreenProps) {
  const expenses = props.trip.state?.expenses ?? [];
  if (expenses.length === 0)
    return (
      <EmptyState>No expenses yet. When someone pays for the group, it shows here.</EmptyState>
    );
  const rows = transactionRows(expenses, props.as);
  const pending = rows.filter((r) => r.line.debtor === props.as && needsMe(r.line));
  return (
    <>
      {pending.length > 0 && (
        <div className="space-y-3 pb-3">
          {pending.map((r) => (
            <PartCard
              key={r.key}
              line={r.line}
              merchant={r.description.split(' · ')[0] ?? ''}
              {...props}
            />
          ))}
        </div>
      )}
      <ul className="divide-y-[1.5px] divide-line">
        {rows.map((r) => (
          <Row key={r.key} row={r} />
        ))}
      </ul>
    </>
  );
}

const when = (iso: string) =>
  new Date(iso).toLocaleString('en-GB', {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });

function Row({ row: r }: { row: TransactionRow }) {
  const color = r.sign === '+' ? 'text-teal' : r.sign === '-' ? 'text-pink' : 'text-ink-muted';
  return (
    <li className={`flex items-center gap-3 py-3 ${r.state === 'voided' ? 'line-through' : ''}`}>
      <Avatar m={r.who} />
      <div className="min-w-0 flex-1">
        <p className="truncate font-semibold capitalize">{r.title}</p>
        <p className="truncate text-small font-normal text-ink-muted">{r.description}</p>
      </div>
      <div className="text-right">
        <p className={`amount font-bold ${color}`}>
          {r.sign === '+' ? '+' : r.sign === '-' ? '−' : ''}
          {formatCents(r.cents)}
        </p>
        <p className="text-small font-normal text-ink-muted">{when(r.at)}</p>
      </div>
    </li>
  );
}

/** My part waiting for me: what my agent will do, the time left, Dispute and Approve. */
function PartCard({ line: l, merchant, trip }: { line: LineView; merchant: string } & ScreenProps) {
  const now = useNow();
  const [disputing, setDisputing] = useState(false);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState<'approve' | 'contest' | null>(null);
  const [error, setError] = useState<ApiClientError | null>(null);
  const left = secondsLeft(l.deadlineAt, trip.clockOffsetMs, now);

  const decide = (decision: 'approve' | 'contest') => {
    setBusy(decision);
    setError(null);
    trip.client
      .decideLine({
        id: l.expenseId,
        decision,
        ...(decision === 'contest' && { reason: reason.trim() }),
      })
      .then(() => {
        setDisputing(false);
        trip.refresh();
      })
      .catch((e: unknown) => setError(toClientError(e)))
      .finally(() => setBusy(null));
  };

  const windowOpen = l.state === 'awaiting_decision';
  return (
    <div className="card-attention" data-noswipe>
      <p className="mb-1 text-small font-semibold text-ink">
        {l.payer} paid {merchant} · your part {formatCents(l.cents)}
      </p>
      <div className="flex items-start justify-between gap-3">
        <p>{l.agent?.reason ?? `Your part: ${formatCents(l.cents)} to ${l.payer}.`}</p>
        {left !== null && (
          <span
            className={`amount shrink-0 ${left < 10 ? 'text-pink' : 'text-ink-muted'}`}
            title={windowOpen ? 'Time left to dispute' : 'Time left to approve'}
          >
            {formatCountdown(left)}
          </span>
        )}
      </div>
      {l.resolution?.note && <p className="mt-1 text-small text-ink">Dave: {l.resolution.note}</p>}

      {disputing ? (
        <form
          className="mt-3 space-y-2"
          onSubmit={(ev) => {
            ev.preventDefault();
            if (reason.trim() !== '') decide('contest');
          }}
        >
          <label className="block text-small font-semibold" htmlFor={`why-${l.expenseId}`}>
            Why do you dispute it? Dave will read this.
          </label>
          <input
            id={`why-${l.expenseId}`}
            autoFocus
            required
            value={reason}
            onChange={(ev) => setReason(ev.target.value)}
            placeholder="I only had water"
            className="field w-full"
          />
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => setDisputing(false)}
              className="btn btn-secondary flex-1"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={reason.trim() === '' || busy !== null}
              className="btn btn-primary flex-1"
            >
              {busy === 'contest' ? 'Signing…' : 'Send dispute'}
            </button>
          </div>
        </form>
      ) : (
        <div className="mt-3 flex gap-2">
          {canDispute(l) && (
            <button
              type="button"
              onClick={() => setDisputing(true)}
              disabled={busy !== null}
              className="btn btn-secondary flex-1"
            >
              Dispute
            </button>
          )}
          {canApprove(l) && (
            <button
              type="button"
              onClick={() => decide('approve')}
              disabled={busy !== null}
              className="btn btn-primary flex-1"
            >
              {busy === 'approve' ? 'Signing…' : 'Approve'}
            </button>
          )}
        </div>
      )}
      {!canDispute(l) && canApprove(l) && (
        <p className="mt-2 text-small text-ink">
          Dave upheld this part: the dispute window is over.
        </p>
      )}
      {error && (
        <div className="mt-2">
          <ErrorBox error={error} />
        </div>
      )}
    </div>
  );
}

// ---------- the simulated second group (SHOW_DEMO_SECOND_GROUP) ----------

/** Made-up rows of a group that does not exist: greyed out, never interactive, no real data. */
export const DEMO_SECOND_GROUP = {
  name: 'Group 2',
  rows: [
    { from: 'A', to: 'B', label: 'Train tickets' },
    { from: 'C', to: 'A', label: 'Museum' },
    { from: 'B', to: 'C', label: 'Breakfast' },
  ],
} as const;

/** The grey, inert card of the simulated group; `header` is its title row. */
export function DemoSecondGroup({ header }: { header: ReactNode }) {
  return (
    <section aria-hidden className="card pointer-events-none text-ink-muted select-none">
      {header}
      <ul className="mt-1 divide-y-[1.5px] divide-line">
        {DEMO_SECOND_GROUP.rows.map((r) => (
          <li key={r.label} className="flex items-center gap-3 py-3">
            <span className="grid size-10 place-items-center rounded-full bg-line font-slab font-bold">
              {r.from}
            </span>
            <div className="flex-1">
              <p className="font-semibold">{r.label}</p>
              <p className="mt-1 h-2 w-24 rounded-full bg-line" />
            </div>
            <span className="h-3 w-12 rounded-full bg-line" />
          </li>
        ))}
      </ul>
    </section>
  );
}
