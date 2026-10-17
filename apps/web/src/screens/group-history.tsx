import {
  formatCents,
  type ApiClientError,
  type ExpenseView,
  type LineView,
  type MemberId,
} from '@kitty/shared';
import { useState } from 'react';
import { EmptyState, ErrorBox, Money } from '../components.js';
import {
  LINE_LABEL,
  canApprove,
  canDispute,
  formatCountdown,
  needsMe,
  secondsLeft,
} from '../lines.js';
import { toClientError, useNow } from '../state.js';
import type { ScreenProps } from './types.js';

// The history of a group: every expense, newest first, with who pays whom. My parts stand out;
// one waiting for me opens inline (PM prototype: the box with Decline/Approve in the list).

export function GroupHistory(props: ScreenProps) {
  const expenses = props.trip.state?.expenses ?? [];
  if (expenses.length === 0)
    return (
      <EmptyState>No expenses yet. When someone pays for the group, it shows here.</EmptyState>
    );
  return (
    <ul className="divide-y divide-gray-100">
      {expenses.map((e) => (
        <ExpenseItem key={e.expenseId} expense={e} {...props} />
      ))}
    </ul>
  );
}

function ExpenseItem({ expense: e, ...props }: { expense: ExpenseView } & ScreenProps) {
  const mine = e.payer === props.as;
  return (
    <li className={`py-3 ${e.status === 'voided' ? 'opacity-50' : ''}`}>
      <div className="flex items-baseline justify-between gap-2">
        <p className="truncate font-medium">{e.merchant}</p>
        <Money cents={e.totalUsdCents} />
      </div>
      <p className="text-xs text-gray-500">
        Paid by {mine ? 'you' : e.payer} · {e.date}
        {e.status === 'settled' && ' · settled'}
        {e.status === 'voided' && ' · voided'}
      </p>
      <ul className="mt-2 space-y-1.5">
        {e.lines.map((l) => (
          <li key={l.debtor}>
            <TransferRow line={l} me={props.as} />
            {l.debtor === props.as && needsMe(l) && <PartCard line={l} {...props} />}
          </li>
        ))}
      </ul>
    </li>
  );
}

/** "bob → alice 3.09 · Paid", the way the prototype draws it: circle, arrow, circle. */
function TransferRow({ line: l, me }: { line: LineView; me: MemberId }) {
  const involved = l.debtor === me || l.payer === me;
  const name = (m: MemberId) => (m === me ? 'you' : m);
  const final = l.state === 'paid' || l.state === 'guaranteed';
  return (
    <div
      className={`flex items-center gap-2 rounded-lg px-2 py-1 text-sm ${involved ? 'bg-pink-50' : ''}`}
    >
      <Avatar m={l.debtor} />
      <span className="text-gray-400">→</span>
      <Avatar m={l.payer} />
      <span className="min-w-0 flex-1 truncate">
        {name(l.debtor)} → {name(l.payer)}
      </span>
      <Money cents={l.cents} unit={false} />
      <span
        className={`w-24 text-right text-xs ${final ? 'text-green-700' : l.state === 'overdue' || l.state === 'contested' ? 'text-red-700' : 'text-gray-500'}`}
      >
        {final ? '✓ ' : ''}
        {LINE_LABEL[l.state]}
      </span>
    </div>
  );
}

function Avatar({ m }: { m: MemberId }) {
  return (
    <span className="grid size-6 shrink-0 place-items-center rounded-full border border-gray-300 bg-white text-[0.65rem] font-semibold uppercase">
      {m.slice(0, 1)}
    </span>
  );
}

/** My part waiting for me: what my agent will do, the time left, Dispute and Approve. */
function PartCard({ line: l, trip }: { line: LineView } & ScreenProps) {
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
    <div
      className="mt-2 ml-8 rounded-xl border border-pink-200 bg-white p-3 shadow-sm"
      data-noswipe
    >
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

export function DemoSecondGroup() {
  return (
    <section aria-hidden className="pointer-events-none opacity-40 grayscale select-none">
      <h2 className="text-lg font-semibold">{DEMO_SECOND_GROUP.name}</h2>
      <ul className="mt-2 space-y-2 rounded-2xl bg-white p-3 shadow-sm">
        {DEMO_SECOND_GROUP.rows.map((r) => (
          <li key={r.label} className="flex items-center gap-2 text-sm">
            <span className="grid size-6 place-items-center rounded-full border border-gray-300 text-[0.65rem]">
              {r.from}
            </span>
            <span className="text-gray-400">→</span>
            <span className="grid size-6 place-items-center rounded-full border border-gray-300 text-[0.65rem]">
              {r.to}
            </span>
            <span className="flex-1 text-gray-500">{r.label}</span>
            <span className="h-2 w-10 rounded bg-gray-200" />
          </li>
        ))}
      </ul>
    </section>
  );
}
