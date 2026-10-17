import {
  formatCents,
  type ApiClientError,
  type DefaultView,
  type DisputeView,
} from '@kitty/shared';
import { ChevronRight } from 'lucide-react';
import { useState } from 'react';
import { guaranteeLeft, parseRate, rateLine } from '../../dave.js';
import { cap } from '../../history.js';
import { toClientError } from '../../state.js';
import { Avatar } from '../../ui/Avatar.js';
import { Button } from '../../ui/Button.js';
import { Section } from '../../ui/List.js';
import { BalancePill } from '../../ui/Money.js';
import { EmptyRow, ErrorNote } from '../../ui/Notes.js';
import { AlertDialog, Sheet } from '../../ui/Overlays.js';
import { Wordmark } from '../../ui/Text.js';
import { Ago, lineKey, type DaveProps } from './DaveApp.js';

// Dave's Home (wireframe, centre): the guarantee pill, then DISPUTES (Cancel / Confirm),
// INSOLVENT (Cover and exclude) and TODAY'S RATE (Set).

const hiddenKey = 'kitty:dave:hideBalance';
function readHidden(): boolean {
  try {
    return localStorage.getItem(hiddenKey) === '1';
  } catch {
    return false;
  }
}

export function DaveHome(props: DaveProps) {
  const { state: s, go } = props;
  const [hidden, setHidden] = useState(readHidden);
  const toggle = () => {
    setHidden(!hidden);
    try {
      localStorage.setItem(hiddenKey, hidden ? '0' : '1');
    } catch {
      // The choice lasts until reload.
    }
  };
  const disputes = s.coordinator?.disputes ?? [];
  const defaults = s.coordinator?.defaults ?? [];
  return (
    <>
      <header className="hairline-b sticky top-0 z-20 flex items-start justify-between bg-bg-cell px-4 pt-[calc(8px+env(safe-area-inset-top))] pb-2">
        <BalancePill
          cents={guaranteeLeft(s)}
          hidden={hidden}
          onToggle={toggle}
          caption="Guarantee left"
        />
        <button
          type="button"
          onClick={() => go({ name: 'profile' })}
          aria-label="Profile"
          className="pressable flex min-h-11 items-center"
        >
          <Wordmark />
        </button>
      </header>
      <div className="space-y-6 px-4 pt-4">
        <Section header="Disputes">
          {disputes.length === 0 ? (
            <Empty text="No disputes. Everyone agrees on the expenses." />
          ) : (
            disputes.map((d, i) => (
              <DisputeCard
                key={lineKey(d.expenseId, d.debtor)}
                d={d}
                last={i === disputes.length - 1}
                {...props}
              />
            ))
          )}
        </Section>
        <Section header="Insolvent">
          {defaults.length === 0 ? (
            <Empty text="Everyone is paying on time." />
          ) : (
            defaults.map((d, i) => (
              <DefaultRow
                key={lineKey(d.expenseId, d.debtor)}
                d={d}
                last={i === defaults.length - 1}
                {...props}
              />
            ))
          )}
        </Section>
        <RateSection {...props} />
        <p className="text-center text-footnote text-label-2">Group: {s.trip?.name ?? '—'}</p>
      </div>
    </>
  );
}

function Empty({ text }: { text: string }) {
  return <EmptyRow>{text}</EmptyRow>;
}

function DisputeCard({ d, last, state, trip, go }: DaveProps & { d: DisputeView; last: boolean }) {
  const [busy, setBusy] = useState(false);
  const [confirmVoid, setConfirmVoid] = useState(false);
  const [error, setError] = useState<ApiClientError | null>(null);
  const resolve = (outcome: 'upheld' | 'line_voided') => {
    setBusy(true);
    setError(null);
    trip.client
      .resolveDispute({
        expenseId: d.expenseId,
        member: d.debtor,
        outcome,
        note:
          outcome === 'upheld'
            ? 'Confirmed by the coordinator'
            : 'Part cancelled by the coordinator',
      })
      .then(trip.refresh)
      .catch((e: unknown) => setError(toClientError(e)))
      .finally(() => setBusy(false));
  };
  const deadline = state.trip?.params.paymentDeadlineSeconds ?? 0;
  return (
    <div className={`px-4 py-3 ${last ? '' : 'hairline-b'}`}>
      <button
        type="button"
        onClick={() => go({ name: 'dispute', expenseId: d.expenseId, member: d.debtor })}
        className="pressable flex w-full items-center gap-3 text-left"
      >
        <Avatar name={d.debtor} size={32} />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-headline font-semibold">
            {cap(d.debtor)} · {formatCents(d.cents)}
          </span>
          <span className="block truncate text-subhead text-label-2">{d.merchant}</span>
          <span className="block truncate text-subhead text-label italic">“{d.reason}”</span>
        </span>
        <ChevronRight size={18} strokeWidth={1.75} className="shrink-0 text-label-3" />
      </button>
      <div className="mt-3 flex flex-col-reverse gap-2">
        <Button variant="gray" full disabled={busy} onClick={() => setConfirmVoid(true)}>
          Cancel {cap(d.debtor)}'s part
        </Button>
        <Button full disabled={busy} onClick={() => resolve('upheld')}>
          {busy ? 'Signing…' : 'Confirm'}
        </Button>
      </div>
      <p className="mt-2 text-footnote text-label-2">
        <Ago iso={d.contestedAt} prefix="opened" />
      </p>
      {error && <ErrorNote error={error} className="mt-2" />}
      {confirmVoid && (
        <AlertDialog
          title={`Cancel ${cap(d.debtor)}'s part?`}
          message={`${cap(d.debtor)} will owe nothing for ${d.merchant}. ${cap(d.payer)} is not repaid this ${formatCents(d.cents)}. Confirm instead to make ${cap(d.debtor)} pay within ${deadline} s.`}
          confirm="Cancel part"
          destructive
          onCancel={() => setConfirmVoid(false)}
          onConfirm={() => {
            setConfirmVoid(false);
            resolve('line_voided');
          }}
        />
      )}
    </div>
  );
}

function DefaultRow({ d, last, go, covers }: DaveProps & { d: DefaultView; last: boolean }) {
  const job = covers.get(lineKey(d.expenseId, d.debtor));
  return (
    <div className={`px-4 py-3 ${last ? '' : 'hairline-b'}`}>
      <div className="flex items-center gap-3">
        <Avatar name={d.debtor} size={32} />
        <span className="min-w-0 flex-1 truncate text-headline font-semibold">
          {cap(d.debtor)} · {formatCents(d.cents)} overdue
        </span>
      </div>
      <Button
        variant="destructive"
        full
        className="mt-3"
        onClick={() => go({ name: 'cover', expenseId: d.expenseId, member: d.debtor })}
      >
        {job?.status === 'running' ? 'Covering… see progress' : 'Cover and exclude'}
      </Button>
      <p className="mt-2 text-footnote text-label-2">
        <Ago iso={d.overdueSince} prefix="approval expired" /> ·{' '}
        {d.coverable
          ? `guarantee left ${formatCents(d.guaranteeLeftCents)}`
          : `above the guarantee left (${formatCents(d.guaranteeLeftCents)})`}
      </p>
    </div>
  );
}

function RateSection({ state: s, trip }: DaveProps) {
  const [editing, setEditing] = useState<string | null>(null);
  const rates = Object.entries(s.rate?.rates ?? {}).filter(([c]) => c !== 'USD');
  return (
    <Section
      header="Today's rate"
      footer={
        s.rate ? `${s.rate.source} · ${s.rate.asOf}` : 'No rate yet: travelers cannot add expenses.'
      }
    >
      {rates.map(([currency, rate], i) => (
        <div
          key={currency}
          className={`ml-4 flex min-h-11 items-center gap-3 pr-2 ${i < rates.length - 1 ? 'hairline-b' : ''}`}
        >
          <span className="tabular flex-1 text-body">{rateLine(currency, rate ?? '')}</span>
          <Button variant="plain" onClick={() => setEditing(currency)}>
            Set
          </Button>
        </div>
      ))}
      {editing !== null && s.rate && (
        <RateSheet
          currency={editing}
          current={s.rate.rates[editing as keyof typeof s.rate.rates] ?? ''}
          onClose={() => setEditing(null)}
          onSave={(value) =>
            trip.client
              .putRates({
                asOf: new Date().toISOString().slice(0, 10),
                source: 'Set by the coordinator',
                rates: { ...s.rate!.rates, [editing]: value },
              })
              .then(() => {
                trip.refresh();
                setEditing(null);
              })
          }
        />
      )}
    </Section>
  );
}

function RateSheet({
  currency,
  current,
  onClose,
  onSave,
}: {
  currency: string;
  current: string;
  onClose: () => void;
  onSave: (value: string) => Promise<void>;
}) {
  const [text, setText] = useState(current);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiClientError | null>(null);
  const value = parseRate(text);
  return (
    <Sheet
      title={`${currency} rate of the day`}
      subtitle="Signed and shared with the group. Locked on each new expense."
      onClose={onClose}
    >
      <form
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          if (value === null) return;
          setBusy(true);
          setError(null);
          onSave(value)
            .catch((err: unknown) => setError(toClientError(err)))
            .finally(() => setBusy(false));
        }}
      >
        <label className="flex min-h-11 items-center gap-2 rounded-control bg-bg-fill px-3">
          <span className="text-body text-label-2">1 DUSD =</span>
          <input
            autoFocus
            inputMode="decimal"
            value={text}
            onChange={(e) => setText(e.target.value)}
            aria-invalid={value === null}
            aria-label={`${currency} per DUSD`}
            className="tabular min-w-0 flex-1 bg-transparent text-body"
          />
          <span className="text-body text-label-2">{currency}</span>
        </label>
        {error && <ErrorNote error={error} />}
        <Button type="submit" full disabled={value === null || busy}>
          {busy ? 'Signing…' : 'Set the rate'}
        </Button>
        <Button variant="plain" full onClick={onClose}>
          Cancel
        </Button>
      </form>
    </Sheet>
  );
}
