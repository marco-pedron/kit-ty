import { formatCents, type MemberId, type ApiClientError } from '@kitty/shared';
import { useState } from 'react';
import { splitOf } from '../../dave.js';
import { cap } from '../../history.js';
import { formatMinor } from '../../receipt-edit.js';
import { toClientError } from '../../state.js';
import { Avatar } from '../../ui/Avatar.js';
import { NavBar } from '../../ui/Bars.js';
import { Button } from '../../ui/Button.js';
import { Row, Section } from '../../ui/List.js';
import { ErrorNote } from '../../ui/Notes.js';
import { AlertDialog, StateView } from '../../ui/Overlays.js';
import { findDispute, type DaveProps } from './DaveApp.js';

// A dispute (wireframe, bottom left): the receipt rows the AI read, the debtor's reason, the
// split; "Cancel expense" voids the whole expense, "Confirm" upholds the part (SPEC §6.6).

export function DisputeScreen({
  state: s,
  trip,
  go,
  expenseId,
  member,
}: DaveProps & { expenseId: string; member: MemberId }) {
  const d = findDispute(s, expenseId, member);
  const e = s.expenses.find((x) => x.expenseId === expenseId);
  const [busy, setBusy] = useState(false);
  const [confirmVoid, setConfirmVoid] = useState(false);
  const [error, setError] = useState<ApiClientError | null>(null);
  const back = { label: 'Home', onClick: () => go({ name: 'home' }) };

  if (d === undefined || e === undefined)
    return (
      <>
        <NavBar title="Dispute" back={back} />
        <StateView
          kind="empty"
          title="This dispute is closed"
          text="It was decided already. The log has the signed decision."
          action={{ label: 'Back to Home', onClick: back.onClick }}
        />
      </>
    );

  const resolve = (outcome: 'upheld' | 'expense_voided') => {
    setBusy(true);
    setError(null);
    trip.client
      .resolveDispute({
        expenseId,
        member,
        outcome,
        note:
          outcome === 'upheld'
            ? 'Confirmed by the coordinator'
            : 'Expense cancelled by the coordinator',
      })
      .then(() => {
        trip.refresh();
        go({ name: 'home' });
      })
      .catch((err: unknown) => setError(toClientError(err)))
      .finally(() => setBusy(false));
  };
  const deadline = s.trip?.params.paymentDeadlineSeconds ?? 0;
  const split = splitOf(e);

  return (
    <>
      <NavBar title="Dispute" back={back} />
      <div className="space-y-6 px-4 pt-4">
        <p className="px-4 text-subhead text-label-2">
          {e.merchant} · paid by {cap(e.payer)} · {formatCents(e.totalUsdCents)}
          {'\u00a0'}DUSD
        </p>
        <Section
          header="Receipt"
          footer={`Amounts in ${e.currency}, as read by ${cap(e.payer)}'s AI.`}
        >
          {e.items.map((it, i) => (
            <Row
              key={it.index}
              title={it.label}
              subtitle={it.members.map(cap).join(', ')}
              value={
                <span className="tabular text-label">{formatMinor(it.total, e.currency)}</span>
              }
              last={i === e.items.length - 1}
            />
          ))}
        </Section>
        <Section header={`${cap(member)}'s reason`}>
          <p className="px-4 py-3 text-body italic">“{d.reason}”</p>
        </Section>
        <Section header="Split">
          {split.map((x, i) => (
            <Row
              key={x.member}
              leading={<Avatar name={x.member} size={32} />}
              title={cap(x.member)}
              value={<span className="tabular text-label">{formatCents(x.cents)}</span>}
              last={i === split.length - 1}
            />
          ))}
        </Section>
        {error && <ErrorNote error={error} />}
        <div className="flex gap-2">
          <Button variant="gray" full disabled={busy} onClick={() => setConfirmVoid(true)}>
            Cancel expense
          </Button>
          <Button full disabled={busy} onClick={() => resolve('upheld')}>
            {busy ? 'Signing…' : 'Confirm'}
          </Button>
        </div>
        <p className="text-center text-footnote text-label-2">
          Confirm: {cap(member)} must approve and pay {formatCents(d.cents)} within {deadline} s.
        </p>
      </div>
      {confirmVoid && (
        <AlertDialog
          title="Cancel the whole expense?"
          message={`Nobody owes anything for ${e.merchant}. ${cap(e.payer)} can send it again, corrected.`}
          confirm="Cancel expense"
          destructive
          onCancel={() => setConfirmVoid(false)}
          onConfirm={() => {
            setConfirmVoid(false);
            resolve('expense_voided');
          }}
        />
      )}
    </>
  );
}
