import { Bell, Camera, QrCode, Users } from 'lucide-react';
import { useState } from 'react';
import { ApiClientError } from '@kitty/shared';
import { Avatar } from '../ui/Avatar.js';
import { Badge, LimitBadge } from '../ui/Badge.js';
import { NavBar, TabBar } from '../ui/Bars.js';
import { Button } from '../ui/Button.js';
import { Segmented, Slider } from '../ui/Controls.js';
import { Row, Section, Tile } from '../ui/List.js';
import { Mascot } from '../ui/Mascot.js';
import { ApprovalCard, BalancePill, TransactionRow } from '../ui/Money.js';
import { ErrorNote } from '../ui/Notes.js';
import { Sheet, StateView, Toasts } from '../ui/Overlays.js';
import { Amount, Wordmark } from '../ui/Text.js';

// ?as=styleguide: every primitive of src/ui with its states (DESIGN.md §7), for screenshots and
// review. Made-up values only; nothing here talks to the agent.

const sampleError = new ApiClientError(
  'NODE_UNREACHABLE',
  "Bob's node is not answering.",
  'Try again in a few seconds.',
  503,
);

export function Styleguide() {
  const [seg, setSeg] = useState<'scan' | 'show'>('show');
  const [step, setStep] = useState(20);
  const [sheet, setSheet] = useState(false);
  const [tab, setTab] = useState<'groups' | 'new' | 'qr'>('groups');
  return (
    <main className="mx-auto min-h-dvh max-w-[430px] bg-bg-grouped pb-40 text-label">
      <Toasts toasts={[{ id: 't', kind: 'plus', prefix: '+ty!', text: '3.09 DUSD from Bob' }]} />
      <NavBar title="Styleguide" large back={{ label: 'Back', onClick: () => history.back() }} />
      <div className="space-y-8 px-4">
        <Section header="Brand and type">
          <div className="space-y-2 p-4">
            <Wordmark size="large" />
            <p className="text-large-title font-bold">Large Title 34</p>
            <p className="text-title2 font-bold">Title 2 · 22</p>
            <p className="text-headline font-semibold">Headline · 17</p>
            <p className="text-body">Body · 17</p>
            <p className="text-subhead text-label-2">Subheadline · 15</p>
            <p className="text-footnote text-label-2 uppercase">Footnote · 13</p>
            <p className="text-caption">Caption · 12</p>
            <p className="font-mono text-subhead">7f3a 91c0 … 5be2 c21e</p>
          </div>
        </Section>

        <Section header="Buttons">
          <div className="grid grid-cols-2 gap-2 p-4">
            <Button>Approve</Button>
            <Button variant="gray">Dispute</Button>
            <Button variant="plain">See all</Button>
            <Button variant="destructive">Cover and exclude</Button>
            <Button disabled>Disabled</Button>
            <Button variant="gray" disabled>
              Disabled
            </Button>
          </div>
        </Section>

        <Section header="Badges">
          <div className="flex flex-wrap gap-2 p-4">
            <LimitBadge limitCents={5000n} channelCents={5000n} />
            <LimitBadge limitCents={1000n} channelCents={5000n} />
            <LimitBadge limitCents={0n} channelCents={5000n} />
            <Badge kind="active">active</Badge>
            <Badge kind="insolvent">insolvent</Badge>
            <Badge kind="excluded">excluded</Badge>
            <Badge kind="operator">operator</Badge>
          </div>
        </Section>

        <Section header="Inset grouped list" footer="Separators are 0.5px, inset after the icon.">
          <Row
            leading={
              <Tile tone="accent">
                <Bell size={18} strokeWidth={1.75} />
              </Tile>
            }
            title="Funds"
            value="50.00 DUSD"
            chevron
            onClick={() => undefined}
          />
          <Row
            leading={<Avatar name="bob" size={32} />}
            title="Bob"
            value={<Badge kind="active">active</Badge>}
          />
          <Row title="FAQ" value="soon" disabled last />
        </Section>

        <section className="space-y-3">
          <BalancePill cents={5000n} hidden={false} onToggle={() => undefined} />
          <div className="flex gap-3">
            <Amount cents={1744n} sign="+" />
            <Amount cents={309n} sign="-" />
            <Amount cents={5232n} unit />
          </div>
        </section>

        <div className="rounded-card bg-bg-cell p-4">
          <ApprovalCard
            title="Coffee · Bob paid · 2.10"
            sentence="Paying in 0:38 unless you dispute"
            countdown="0:38"
            busy={false}
            onDispute={() => setSheet(true)}
            onApprove={() => undefined}
          />
          <ul className="mt-3">
            <TransactionRow
              name="alice"
              me
              title="Taxi · you paid"
              subtitle="Bob and Charlie owe 17.44"
              cents={5232n}
              sign={null}
              date="17 Oct, 12:04"
              connector
            />
            <TransactionRow
              name="bob"
              title="Bob paid you"
              subtitle="+ty · Taxi"
              cents={1744n}
              sign="+"
              date="17 Oct, 12:05"
              connector
            />
            <TransactionRow
              name="charlie"
              title="Dinner · Charlie paid"
              subtitle="-ty · paid automatically"
              cents={309n}
              sign="-"
              date="16 Oct, 21:40"
            />
          </ul>
        </div>

        <Section header="Controls">
          <div className="space-y-4 p-4">
            <Segmented
              label="QR mode"
              value={seg}
              onChange={setSeg}
              options={[
                { key: 'scan', label: 'Scan' },
                { key: 'show', label: 'Show' },
              ]}
            />
            <Slider
              value={step}
              max={100}
              onChange={setStep}
              onCommit={() => undefined}
              label="Limit"
              valueText={`${step}`}
            />
          </div>
        </Section>

        <Section header="States">
          <StateView kind="loading" title="Reading the receipt" text="on your phone… 2.4 s" />
          <StateView
            kind="empty"
            title="No expenses yet"
            text="When someone pays for the group, it shows here."
            action={{ label: 'Add an expense', onClick: () => undefined }}
          />
          <div className="p-4">
            <ErrorNote error={sampleError} onRetry={() => undefined} />
          </div>
        </Section>

        <Section header="Mascot">
          <div className="flex items-end gap-4 p-4">
            <Mascot size={22} waving={false} />
            <Mascot size={40} />
            <Mascot size={64} />
            <Mascot size={96} waving={false} />
          </div>
        </Section>
      </div>
      {sheet && (
        <Sheet
          title="Dispute your part"
          subtitle="Taxi · 17.44 · Dave will decide"
          onClose={() => setSheet(false)}
        >
          <div className="space-y-3">
            <textarea
              rows={3}
              aria-label="Reason"
              placeholder="Why? For example: I took the metro"
              className="w-full rounded-control bg-bg-fill px-3 py-2.5 text-body placeholder:text-label-3"
            />
            <Button full>Send dispute</Button>
            <Button variant="plain" full onClick={() => setSheet(false)}>
              Cancel
            </Button>
          </div>
        </Sheet>
      )}
      <TabBar
        items={[
          { key: 'groups', label: 'Groups', icon: <Users size={22} strokeWidth={1.75} /> },
          { key: 'new', label: 'Expense', icon: <Camera size={22} strokeWidth={1.75} /> },
          { key: 'qr', label: 'QR', icon: <QrCode size={22} strokeWidth={1.75} /> },
        ]}
        active={tab}
        onSelect={setTab}
      />
    </main>
  );
}
