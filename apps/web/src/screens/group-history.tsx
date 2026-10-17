import { formatCents, type ApiClientError, type LineView, type MemberId } from '@kitty/shared';
import { useState, type ReactNode } from 'react';
import { EmptyState, ErrorBox } from '../components.js';
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
        <div className="space-y-2 pb-2">
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
      <ul className="divide-y divide-gray-100">
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
  const color =
    r.sign === '+' ? 'text-green-700' : r.sign === '-' ? 'text-red-700' : 'text-gray-500';
  return (
    <li className={`flex items-center gap-3 py-3 ${r.state === 'voided' ? 'opacity-50' : ''}`}>
      <Avatar m={r.who} />
      <div className="min-w-0 flex-1">
        <p className="truncate font-medium capitalize">{r.title}</p>
        <p className="truncate text-xs text-gray-500">{r.description}</p>
      </div>
      <div className="text-right">
        <p className={`font-semibold tabular-nums ${color}`}>
          {r.sign === '+' ? '+' : r.sign === '-' ? '−' : ''}
          {formatCents(r.cents)}
        </p>
        <p className="text-xs text-gray-400">{when(r.at)}</p>
      </div>
    </li>
  );
}

export function Avatar({ m }: { m: MemberId | string }) {
  return (
    <span className="grid size-10 shrink-0 place-items-center rounded-full bg-gray-100 text-sm font-semibold uppercase">
      {m.slice(0, 1)}
    </span>
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
    <div className="rounded-xl border border-pink-200 bg-white p-3 shadow-sm" data-noswipe>
      <p className="mb-1 text-xs font-medium text-gray-500">
        {l.payer} paid {merchant} · your part {formatCents(l.cents)}
      </p>
      <div className="flex items-start justify-between gap-3">
        <p className="text-sm">
          {l.agent?.reason ?? `Your part: ${formatCents(l.cents)} to ${l.payer}.`}
        </p>
        {left !== null && (
          <span
            className="shrink-0 rounded-full bg-gray-900 px-2 py-0.5 font-mono text-xs text-white tabular-nums"
            title={windowOpen ? 'Time left to dispute' : 'Time left to approve'}
          >
            {formatCountdown(left)}
          </span>
        )}
      </div>
      {l.resolution?.note && (
        <p className="mt-1 text-xs text-gray-500">Dave: {l.resolution.note}</p>
      )}

      {disputing ? (
        <form
          className="mt-3 space-y-2"
          onSubmit={(ev) => {
            ev.preventDefault();
            if (reason.trim() !== '') decide('contest');
          }}
        >
          <label className="block text-xs font-medium text-gray-600" htmlFor={`why-${l.expenseId}`}>
            Why do you dispute it? Dave will read this.
          </label>
          <input
            id={`why-${l.expenseId}`}
            autoFocus
            required
            value={reason}
            onChange={(ev) => setReason(ev.target.value)}
            placeholder="I only had water"
            className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
          />
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => setDisputing(false)}
              className="flex-1 rounded-full border border-gray-300 py-2 text-sm font-medium"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={reason.trim() === '' || busy !== null}
              className="flex-1 rounded-full bg-red-600 py-2 text-sm font-semibold text-white disabled:opacity-40"
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
              className="flex-1 rounded-full border border-gray-300 py-2 text-sm font-medium disabled:opacity-40"
            >
              Dispute
            </button>
          )}
          {canApprove(l) && (
            <button
              type="button"
              onClick={() => decide('approve')}
              disabled={busy !== null}
              className="flex-1 rounded-full bg-pink-600 py-2 text-sm font-semibold text-white disabled:opacity-40"
            >
              {busy === 'approve' ? 'Signing…' : 'Approve'}
            </button>
          )}
        </div>
      )}
      {!canDispute(l) && canApprove(l) && (
        <p className="mt-2 text-xs text-gray-500">
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
    <section aria-hidden className="pointer-events-none opacity-40 grayscale select-none">
      <div className="rounded-2xl bg-white p-4 shadow-sm">
        {header}
        <ul className="mt-1 divide-y divide-gray-100">
          {DEMO_SECOND_GROUP.rows.map((r) => (
            <li key={r.label} className="flex items-center gap-3 py-3">
              <Avatar m={r.from} />
              <div className="flex-1">
                <p className="font-medium">{r.label}</p>
                <p className="mt-1 h-2 w-24 rounded bg-gray-200" />
              </div>
              <span className="h-3 w-12 rounded bg-gray-200" />
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
