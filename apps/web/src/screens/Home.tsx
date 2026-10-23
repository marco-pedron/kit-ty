import { DEFAULT_POLICY, formatCents, type ApiClientError, type LineView } from '@kitty/shared';
import { useState } from 'react';
import { SHOW_DEMO_SECOND_GROUP } from '../config.js';
import { approvalText, cap, historyRows } from '../history.js';
import { openProof } from '../nav.js';
import {
  canApprove,
  canDispute,
  canVote,
  formatCountdown,
  needsMe,
  secondsLeft,
} from '../lines.js';
import { toClientError, useNow } from '../state.js';
import { Badge, LimitBadge } from '../ui/Badge.js';
import { Button } from '../ui/Button.js';
import { CatHead } from '../ui/CatHead.js';
import { GroupCard } from '../ui/GroupCard.js';
import { ApprovalCard, BalancePill, TopUpSoon, TransactionRow } from '../ui/Money.js';
import { Sheet, StateView } from '../ui/Overlays.js';
import { ErrorNote } from '../ui/Notes.js';
import { ThemeToggle } from '../ui/Theme.js';
import { Wordmark } from '../ui/Text.js';
import type { ScreenProps } from './types.js';
import { Working } from '../ui/PlusMinus.js';

// Home (wireframe-traveler.pdf, centre): balance pill and eye top left, the kit+ty logo top
// right (Profile); the group title with its limit badge (tap: the slider); the group card with
// the parts waiting for me on top and the history; Group 2 dashed, not active.

export function HomeScreen(props: ScreenProps) {
  const { trip, as, go } = props;
  const s = trip.state;
  const limit = (s?.me?.policy ?? DEFAULT_POLICY).autoPayLimitCents;
  const [disputing, setDisputing] = useState<{ line: LineView; merchant: string } | null>(null);

  const mine = s?.members.find((m) => m.memberId === as);
  if (mine?.status === 'excluded' || mine?.registry?.excluded === true)
    return <ExcludedScreen {...props} />;
  if (mine?.status === 'left') return <LeftScreen {...props} />;
  return (
    <>
      <TopBar {...props} />
      <div className="space-y-6 px-4 pt-4">
        <GroupCard
          title={s?.trip?.name ?? 'Your group'}
          badge={
            s?.trip != null && (
              <LimitBadge
                limitCents={limit}
                channelCents={s.trip.params.tripChannelCents}
                onClick={() => go('group')}
              />
            )
          }
        >
          {s?.trip == null ? (
            <StateView
              kind="loading"
              title="Waiting for the trip"
              text={
                s?.registry === 'v2'
                  ? 'Joining the group with the invite.'
                  : 'Dave, the coordinator, is setting it up.'
              }
            />
          ) : (
            <GroupBody {...props} limit={limit} onDispute={setDisputing} />
          )}
        </GroupCard>
        {SHOW_DEMO_SECOND_GROUP && (
          <GroupCard
            title="Group 2"
            muted
            badge={<Badge kind="muted">Limit 10.00 DUSD</Badge>}
            aria-label="Group 2, not active yet"
          >
            <p className="py-1 text-center text-subhead text-label-3">not active yet</p>
          </GroupCard>
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
        onOpen={{ label: 'Trip channel balance: change the limit', onClick: () => go('group') }}
        aside={<TopUpSoon />}
      />
      <div className="flex items-center">
        <ThemeToggle />
        <button
          type="button"
          onClick={() => go('profile')}
          aria-label="Profile"
          className="pressable flex min-h-11 items-center"
        >
          <Wordmark />
        </button>
      </div>
    </header>
  );
}

/** After Cover and exclude: the out head, who covered, what is left, and the log. */
function ExcludedScreen({ trip, go }: ScreenProps) {
  const s = trip.state;
  const left = s?.me?.balance;
  return (
    <div className="flex flex-col items-center px-8 pt-[18dvh] text-center">
      <CatHead variant="out" size={128} label="The kitten, out of the group" />
      <h1 className="mt-6 text-title2 font-bold">You're out of {s?.trip?.name ?? 'the group'}.</h1>
      <p className="mt-1 text-body text-label-2">
        {s?.registry === 'v2'
          ? 'More than half of the others blocked you. What you owe stays: pay it by hand.'
          : 'Dave covered your part.'}
      </p>
      <div className="card mt-6 px-5 py-3">
        <p className="text-footnote text-label-2">Your funds, back on-chain</p>
        <p className="tabular text-title2 font-semibold">
          {left == null ? '—' : `${formatCents(left.onchainCents)} DUSD`}
        </p>
      </div>
      <Button variant="plain" className="mt-4" onClick={() => go('log')}>
        See the verified log
      </Button>
    </div>
  );
}

/** KITTY_REGISTRY=v2: I left the trip; my channels with the LSP are closed. */
function LeftScreen({ trip, go }: ScreenProps) {
  const s = trip.state;
  const closed = s?.trip?.status === 'closed';
  return (
    <div className="flex flex-col items-center px-8 pt-[18dvh] text-center">
      <CatHead variant="out" size={128} label="The kitten, home from the trip" />
      <h1 className="mt-6 text-title2 font-bold">You left {s?.trip?.name ?? 'the trip'}.</h1>
      <p className="mt-1 text-body text-label-2">
        Your channels with the LSP are closed.{' '}
        {closed
          ? 'Everyone has left: the trip is closed.'
          : 'The trip closes when everyone has left.'}
      </p>
      <div className="card mt-6 px-5 py-3">
        <p className="text-footnote text-label-2">Your funds, back on-chain</p>
        <p className="tabular text-title2 font-semibold">
          {s?.me?.balance == null ? '—' : `${formatCents(s.me.balance.onchainCents)} DUSD`}
        </p>
      </div>
      <Button variant="plain" className="mt-4" onClick={() => go('log')}>
        See the verified log
      </Button>
    </div>
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
  const votes = expenses.flatMap((e) =>
    e.lines.filter((l) => canVote(l)).map((line) => ({ line, merchant: e.merchant })),
  );

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
      {votes.length > 0 && (
        <div className="space-y-3 pb-3">
          {votes.map((v) => (
            <VoteCard
              key={`${v.line.expenseId}:${v.line.debtor}`}
              trip={trip}
              line={v.line}
              merchant={v.merchant}
            />
          ))}
        </div>
      )}
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
            fiat={r.fiat}
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

/**
 * KITTY_REGISTRY=v2 (23/10, provisional): a part someone else disputed; I am one of the voters
 * (neither its payer nor its debtor). More than half of the voters decide, for good.
 */
function VoteCard({
  trip,
  line: l,
  merchant,
}: Pick<ScreenProps, 'trip'> & { line: LineView; merchant: string }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiClientError | null>(null);
  const vote = (outcome: 'due' | 'voided') => {
    setBusy(true);
    setError(null);
    trip.client
      .voteLine({ id: l.expenseId, member: l.debtor, outcome })
      .then(() => trip.refresh())
      .catch((e: unknown) => setError(toClientError(e)))
      .finally(() => setBusy(false));
  };
  const voters = l.group?.voters.length ?? 0;
  return (
    <div className="card px-4 py-3">
      <p className="text-subhead font-semibold">
        {cap(l.debtor)} disputes {formatCents(l.cents)} DUSD · {merchant}
      </p>
      <p className="mt-1 text-footnote text-label-2">
        “{l.contestReason ?? ''}” · You are one of {voters} {voters === 1 ? 'voter' : 'voters'}:
        more than half decides, for good.
      </p>
      <div className="mt-3 flex gap-2">
        <Button variant="gray" disabled={busy} onClick={() => vote('voided')}>
          Void it
        </Button>
        <Button disabled={busy} onClick={() => vote('due')}>
          {busy ? <Working /> : `${cap(l.debtor)} owes it`}
        </Button>
      </div>
      {error && <ErrorNote error={error} className="mt-3" />}
    </div>
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
      subtitle={`${merchant} · ${formatCents(l.cents)} to ${cap(l.payer)} · ${
        trip.state?.registry === 'v2'
          ? 'the others in the group will decide, or you withdraw it'
          : 'Dave will decide'
      }`}
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
          {busy ? <Working /> : 'Send dispute'}
        </Button>
        <Button variant="plain" full onClick={onClose}>
          Cancel
        </Button>
      </form>
    </Sheet>
  );
}
