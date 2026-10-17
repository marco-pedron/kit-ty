import { DEFAULT_POLICY, formatCents, type ApiClientError, type LineView } from '@kitty/shared';
import { useState } from 'react';
import { SHOW_DEMO_SECOND_GROUP } from '../config.js';
import { approvalText, cap, historyRows } from '../history.js';
import { openProof } from '../nav.js';
import { canApprove, canDispute, formatCountdown, needsMe, secondsLeft } from '../lines.js';
import { toClientError, useNow } from '../state.js';
import { Badge, LimitBadge } from '../ui/Badge.js';
import { Button } from '../ui/Button.js';
import { ApprovalCard, BalancePill, TransactionRow } from '../ui/Money.js';
import { Sheet, StateView } from '../ui/Overlays.js';
import { ErrorNote } from '../ui/Notes.js';
import { Wordmark } from '../ui/Text.js';
import type { ScreenProps } from './types.js';

// Home (wireframe-traveler.pdf, centre): balance pill and eye top left, the kit+ty logo top
// right (Profile); the group title with its limit badge (tap: the slider); the group card with
// the parts waiting for me on top and the history; Group 2 dashed, not active.

export function HomeScreen(props: ScreenProps) {
  const { trip, as, go } = props;
  const s = trip.state;
  const limit = (s?.me?.policy ?? DEFAULT_POLICY).autoPayLimitCents;
  const [disputing, setDisputing] = useState<{ line: LineView; merchant: string } | null>(null);

  return (
    <>
      <TopBar {...props} />
      <div className="space-y-6 px-4 pt-4">
        <section>
          <div className="flex items-center justify-between gap-3 pb-2">
            <h2 className="truncate text-title2 font-bold">{s?.trip?.name ?? 'Your group'}</h2>
            {s?.trip != null && (
              <LimitBadge
                limitCents={limit}
                channelCents={s.trip.params.tripChannelCents}
                onClick={() => go('group')}
              />
            )}
          </div>
          <div className={SHOW_DEMO_SECOND_GROUP ? 'rounded-card bg-bg-cell p-4' : ''}>
            {s?.trip == null ? (
              <StateView
                kind="loading"
                title="Waiting for the trip"
                text="Dave, the coordinator, is setting it up."
              />
            ) : (
              <GroupBody {...props} limit={limit} onDispute={setDisputing} />
            )}
          </div>
        </section>
        {SHOW_DEMO_SECOND_GROUP && (
          <section aria-label="Group 2, not active yet">
            <div className="flex items-center justify-between gap-3 pb-2">
              <h2 className="text-title2 font-bold text-label-3">Group 2</h2>
              <Badge kind="muted">Limit 10.00</Badge>
            </div>
            <p className="rounded-card border border-dashed border-separator py-5 text-center text-subhead text-label-3">
              not active yet
            </p>
          </section>
        )}
      </div>
      {disputing !== null && (
        <DisputeSheet
          {...props}
          line={disputing.line}
          merchant={disputing.merchant}
          onClose={() => setDisputing(null)}
        />
      )}
      <span className="sr-only">Signed in as {as}</span>
    </>
  );
}

const hiddenKey = (as: string) => `kitty:${as}:hideBalance`;

function readHidden(as: string): boolean {
  try {
    return localStorage.getItem(hiddenKey(as)) === '1';
  } catch {
    return false;
  }
}

function TopBar({ trip, as, go }: ScreenProps) {
  const [hidden, setHidden] = useState(() => readHidden(as));
  const toggle = () => {
    setHidden(!hidden);
    try {
      localStorage.setItem(hiddenKey(as), hidden ? '0' : '1');
    } catch {
      // Private window or blocked storage: the choice lasts until reload.
    }
  };
  return (
    <header className="hairline-b sticky top-0 z-20 flex items-start justify-between bg-bg-cell px-4 pt-[calc(8px+env(safe-area-inset-top))] pb-2">
      <BalancePill
        cents={trip.state?.me?.balance?.tripOutboundCents ?? null}
        hidden={hidden}
        onToggle={toggle}
      />
      <button
        type="button"
        onClick={() => go('profile')}
        aria-label="Profile"
        className="pressable flex min-h-11 items-center"
      >
        <Wordmark />
      </button>
    </header>
  );
}

/** Today: "21:22"; before: "16 Oct". */
function when(iso: string): string {
  const d = new Date(iso);
  return d.toDateString() === new Date().toDateString()
    ? d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })
    : d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
}

function GroupBody({
  trip,
  as,
  go,
  limit,
  onDispute,
}: ScreenProps & {
  limit: bigint;
  onDispute: (d: { line: LineView; merchant: string }) => void;
}) {
  const expenses = trip.state?.expenses ?? [];
  const pending = expenses.flatMap((e) =>
    e.lines
      .filter((l) => l.debtor === as && needsMe(l))
      .map((line) => ({ line, merchant: e.merchant })),
  );
  const rows = historyRows(expenses, as, (l) => l.debtor === as && needsMe(l));

  if (expenses.length === 0)
    return (
      <StateView
        kind="empty"
        title="No expenses yet"
        text="When someone pays for the group, it shows here."
        action={{ label: 'Add an expense', onClick: () => go('new') }}
      />
    );
  return (
    <>
      {pending.length > 0 && (
        <div className={`space-y-3 ${rows.length > 0 ? 'pb-3' : ''}`}>
          {pending.map((p) => (
            <PendingPart
              key={p.line.expenseId}
              trip={trip}
              line={p.line}
              merchant={p.merchant}
              limit={limit}
              onDispute={() => onDispute(p)}
            />
          ))}
        </div>
      )}
      <ul>
        {rows.map((r, i) => (
          <TransactionRow
            key={r.key}
            name={r.name}
            me={r.me}
            title={r.title}
            subtitle={r.subtitle}
            cents={r.cents}
            sign={r.sign}
            date={when(r.at)}
            connector={i < rows.length - 1}
            muted={r.muted}
            waitingSince={r.waitingSince}
            {...(r.proof !== null && { onClick: () => openProof(r.proof!) })}
          />
        ))}
      </ul>
    </>
  );
}

function PendingPart({
  trip,
  line: l,
  merchant,
  limit,
  onDispute,
}: Pick<ScreenProps, 'trip'> & {
  line: LineView;
  merchant: string;
  limit: bigint;
  onDispute: () => void;
}) {
  const now = useNow();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiClientError | null>(null);
  const left = secondsLeft(l.deadlineAt, trip.clockOffsetMs, now);
  const { title, sentence } = approvalText(l, merchant, limit, left);

  const approve = () => {
    setBusy(true);
    setError(null);
    trip.client
      .decideLine({ id: l.expenseId, decision: 'approve' })
      .then(() => trip.refresh())
      .catch((e: unknown) => setError(toClientError(e)))
      .finally(() => setBusy(false));
  };

  return (
    <ApprovalCard
      title={title}
      sentence={sentence}
      countdown={left === null ? null : formatCountdown(left)}
      busy={busy}
      {...(canDispute(l) && { onDispute })}
      {...(canApprove(l) && { onApprove: approve })}
      {...(l.resolution?.note ? { note: `Dave: ${l.resolution.note}` } : {})}
    >
      {error && <ErrorNote error={error} who={cap(l.payer)} className="mt-3" />}
    </ApprovalCard>
  );
}

/** Dispute your part (wireframe story 1): the reason is required, Dave reads it. */
function DisputeSheet({
  trip,
  line: l,
  merchant,
  onClose,
}: Pick<ScreenProps, 'trip'> & { line: LineView; merchant: string; onClose: () => void }) {
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiClientError | null>(null);

  const send = () => {
    setBusy(true);
    setError(null);
    trip.client
      .decideLine({ id: l.expenseId, decision: 'contest', reason: reason.trim() })
      .then(() => {
        trip.refresh();
        onClose();
      })
      .catch((e: unknown) => setError(toClientError(e)))
      .finally(() => setBusy(false));
  };

  return (
    <Sheet
      title="Dispute your part"
      subtitle={`${merchant} · ${formatCents(l.cents)} to ${cap(l.payer)} · Dave will decide`}
      onClose={onClose}
    >
      <form
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          if (reason.trim() !== '') send();
        }}
      >
        <label htmlFor="dispute-reason" className="sr-only">
          Why do you dispute it?
        </label>
        <textarea
          id="dispute-reason"
          autoFocus
          required
          rows={3}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="Why? For example: I took the metro"
          className="w-full resize-none rounded-control bg-bg-fill px-3 py-2.5 text-body text-label placeholder:text-label-3"
        />
        {error && <ErrorNote error={error} />}
        <Button type="submit" full disabled={reason.trim() === '' || busy}>
          {busy ? 'Signing…' : 'Send dispute'}
        </Button>
        <Button variant="plain" full onClick={onClose}>
          Cancel
        </Button>
      </form>
    </Sheet>
  );
}
