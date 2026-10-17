import { formatCents, type MemberId } from '@kitty/shared';
import { useState } from 'react';
import { cap } from '../../history.js';
import { useNow } from '../../state.js';
import { Avatar } from '../../ui/Avatar.js';
import { NavBar } from '../../ui/Bars.js';
import { Button } from '../../ui/Button.js';
import { Section } from '../../ui/List.js';
import { Mascot } from '../../ui/Mascot.js';
import { ErrorNote } from '../../ui/Notes.js';
import { AlertDialog, StateView } from '../../ui/Overlays.js';
import { ProgressBar, Steps, type StepState } from '../../ui/Steps.js';
import { lineKey, type DaveProps } from './DaveApp.js';

// "Cover and exclude" (wireframe, bottom right; SPEC §6.7): a confirmation that says what will
// happen, then the three steps as they land in the log: the guarantee pays the creditor, the
// member's channels close, MEMBER_EXCLUDED is signed. On the real nodes it takes about a minute;
// the request lives in DaveApp, so Dave can leave and come back.

export function CoverScreen({
  state: s,
  go,
  covers,
  startCover,
  expenseId,
  member,
}: DaveProps & { expenseId: string; member: MemberId }) {
  const now = useNow(500);
  const job = covers.get(lineKey(expenseId, member));
  const e = s.expenses.find((x) => x.expenseId === expenseId);
  const line = e?.lines.find((l) => l.debtor === member);
  const m = s.members.find((x) => x.memberId === member);
  const d = s.coordinator?.defaults.find((x) => x.expenseId === expenseId && x.debtor === member);
  const [asked, setAsked] = useState(false);
  const back = { label: 'Home', onClick: () => go({ name: 'home' }) };

  if (line === undefined || m === undefined || e === undefined)
    return (
      <>
        <NavBar title="Cover and exclude" back={back} />
        <StateView
          kind="empty"
          title="Nothing to cover"
          action={{ label: 'Back to Home', onClick: back.onClick }}
        />
      </>
    );

  const paid = line.state === 'guaranteed' || line.state === 'paid';
  const closed = m.closingTxids.length > 0 || m.status === 'excluded';
  const excluded = m.status === 'excluded';
  const finished = paid && excluded;
  const failed = job?.status === 'failed';
  const started = job !== undefined || paid || excluded;

  const states: StepState[] = [paid, closed, excluded].map((done) => (done ? 'done' : 'todo'));
  const current = states.indexOf('todo');
  if (current >= 0 && started) states[current] = failed ? 'failed' : 'active';
  const progress = states.filter((x) => x === 'done').length / 3;
  const elapsed = job ? Math.floor((now - job.startedAt) / 1000) : null;

  return (
    <>
      <NavBar title="Cover and exclude" back={back} />
      <div className="space-y-6 px-4 pt-4">
        <div className="flex items-center gap-3 px-1">
          <Avatar name={member} size={40} />
          <div>
            <p className="text-headline font-semibold">{cap(member)}</p>
            <p className="text-subhead text-label-2">
              owes {formatCents(line.cents)} DUSD to {cap(line.payer)}
            </p>
          </div>
        </div>
        <Section>
          <div className="space-y-4 p-4">
            <Steps
              steps={[
                {
                  label: `Pay ${formatCents(line.cents)} to ${cap(line.payer)} from the guarantee`,
                  state: states[0] ?? 'todo',
                },
                { label: `Close ${cap(member)}'s channels`, state: states[1] ?? 'todo' },
                { label: 'Sign MEMBER_EXCLUDED', state: states[2] ?? 'todo' },
              ]}
            />
            {started && !finished && <ProgressBar value={progress} label="Cover and exclude" />}
            {started && !finished && !failed && (
              <div className="flex items-center gap-3">
                <Mascot size={40} />
                <p className="text-footnote text-label-2">
                  About 1 min{elapsed !== null ? ` · ${elapsed} s so far` : ''} · you can leave this
                  screen
                </p>
              </div>
            )}
          </div>
        </Section>
        {failed && job?.error && (
          <ErrorNote error={job.error} onRetry={() => startCover({ expenseId, debtor: member })} />
        )}
        {finished && (
          <Section footer={m.closingTxids.length > 0 ? 'Closing transactions' : undefined}>
            <div className="p-4 text-center">
              <p className="text-headline font-semibold">{cap(member)} excluded. Group covered.</p>
              <p className="mt-1 text-subhead text-label-2">
                The operator now holds a credit of {formatCents(line.cents)} toward {cap(member)}.
              </p>
              {m.closingTxids.map((t) => (
                <p key={t} className="mt-2 truncate font-mono text-footnote text-label-2">
                  {t}
                </p>
              ))}
            </div>
          </Section>
        )}
        {!started && (
          <Button variant="destructive" full onClick={() => setAsked(true)}>
            Cover and exclude
          </Button>
        )}
        {finished && (
          <Button variant="gray" full onClick={back.onClick}>
            Back to Home
          </Button>
        )}
      </div>
      {asked && (
        <AlertDialog
          title={`Cover ${cap(member)} and exclude?`}
          message={
            d !== undefined && !d.coverable
              ? `${formatCents(line.cents)} is above the guarantee left (${formatCents(d.guaranteeLeftCents)}): ${cap(line.payer)} is not covered. ${cap(member)}'s channels close and the funds go back to ${cap(member)} on-chain.`
              : `The operator pays ${cap(line.payer)} ${formatCents(line.cents)} from the guarantee, then closes ${cap(member)}'s channels. ${cap(member)} gets the funds back on-chain and leaves the group.`
          }
          confirm="Cover and exclude"
          destructive
          onCancel={() => setAsked(false)}
          onConfirm={() => {
            setAsked(false);
            startCover({ expenseId, debtor: member });
          }}
        />
      )}
    </>
  );
}
