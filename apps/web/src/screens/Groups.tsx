import { DEFAULT_POLICY, formatCents, type ApiClientError } from '@kitty/shared';
import { ChevronRight } from 'lucide-react';
import { useState } from 'react';
import { SHOW_DEMO_SECOND_GROUP } from '../config.js';
import { cap } from '../history.js';
import { paymentMode } from '../mode.js';
import { limitFromStep, memberStanding, sliderSteps, stepFromLimit } from '../slider.js';
import { toClientError } from '../state.js';
import { Avatar } from '../ui/Avatar.js';
import { Badge, LimitBadge } from '../ui/Badge.js';
import { NavBar } from '../ui/Bars.js';
import { Button } from '../ui/Button.js';
import { Slider } from '../ui/Controls.js';
import { Row, Section } from '../ui/List.js';
import { ErrorNote } from '../ui/Notes.js';
import { StateView } from '../ui/Overlays.js';
import type { ScreenProps } from './types.js';
import { Working } from '../ui/PlusMinus.js';

// Groups (wireframe, bottom left): each group with my balance and its limit badge; Group 2 dashed
// and inactive; "Join group" later. Group settings (bottom right): the one limit slider, the
// daily cap read-only, the members.

export function GroupsScreen({ trip, go }: ScreenProps) {
  const s = trip.state;
  const balance = s?.me?.balance ?? null;
  const limit = (s?.me?.policy ?? DEFAULT_POLICY).autoPayLimitCents;
  return (
    <>
      <NavBar title="Groups" large back={{ label: 'Home', onClick: () => go('home') }} />
      <div className="space-y-3 px-4">
        {s?.trip == null ? (
          <StateView kind="loading" title="Looking for your groups" />
        ) : (
          <div className="rounded-card bg-bg-cell">
            <button
              type="button"
              onClick={() => go('group')}
              className="pressable flex w-full items-center gap-3 px-4 pt-3.5 pb-1 text-left"
            >
              <span className="flex-1 text-headline font-semibold">{s.trip.name}</span>
              <ChevronRight size={18} strokeWidth={1.75} className="text-label-3" />
            </button>
            <div className="flex items-center justify-between px-4 pb-3.5">
              <span className="tabular text-title2 font-bold">
                {balance === null ? '—' : formatCents(balance.tripOutboundCents)}
                <span className="ml-1 text-footnote font-normal text-label-2">DUSD</span>
              </span>
              <LimitBadge
                limitCents={limit}
                channelCents={s.trip.params.tripChannelCents}
                onClick={() => go('group')}
              />
            </div>
          </div>
        )}
        {SHOW_DEMO_SECOND_GROUP && (
          <div
            aria-label="Group 2, not active yet"
            className="rounded-card border border-dashed border-separator px-4 py-3.5 text-label-3"
          >
            <p className="text-headline font-semibold">Group 2</p>
            <div className="mt-1 flex items-center justify-between">
              <span className="text-subhead">not active yet</span>
              <Badge kind="muted">Limit 10.00</Badge>
            </div>
          </div>
        )}
        <div className="flex justify-center pt-3">
          <Button variant="gray" disabled>
            Join group… (soon)
          </Button>
        </div>
      </div>
    </>
  );
}

export function GroupSettingsScreen({ trip, as, go }: ScreenProps) {
  const s = trip.state;
  if (s?.trip == null || s.me === null)
    return (
      <>
        <NavBar title="Group" back={{ label: 'Groups', onClick: () => go('groups') }} />
        <StateView kind="loading" title="Waiting for the trip" />
      </>
    );
  const { params } = s.trip;
  return (
    <>
      <NavBar title={s.trip.name} back={{ label: 'Groups', onClick: () => go('groups') }} />
      <div className="space-y-6 px-4 pt-4">
        <div className="flex flex-col items-center">
          <Avatar name={as} me size={96} />
          <p className="mt-2 text-title2 font-bold">{cap(as)}</p>
        </div>
        <LimitSlider
          trip={trip}
          channelCents={params.tripChannelCents}
          windowSeconds={params.silentAssentSeconds}
        />
        <Section header="Members">
          {s.members.map((m) => {
            const st = memberStanding(m, s.expenses);
            return (
              <Row
                key={m.memberId}
                leading={
                  <Avatar
                    name={m.displayName}
                    me={m.memberId === as}
                    size={32}
                    {...(st === 'excluded' && { variant: 'out' as const })}
                  />
                }
                title={`${cap(m.displayName)}${m.memberId === as ? ' (you)' : ''}`}
                value={<Badge kind={st}>{st}</Badge>}
              />
            );
          })}
          <Row
            leading={<Avatar name="dave" size={32} />}
            title="Dave"
            subtitle="Coordinator"
            value={<Badge kind="operator">operator</Badge>}
            last
          />
        </Section>
      </div>
    </>
  );
}

/** Saved on release, as one signed POLICY_UPDATED; the daily cap is sent back unchanged. */
function LimitSlider({
  trip,
  channelCents,
  windowSeconds,
}: Pick<ScreenProps, 'trip'> & { channelCents: bigint; windowSeconds: number }) {
  const s = trip.state;
  const policy = s?.me?.policy ?? DEFAULT_POLICY;
  const [step, setStep] = useState(() => stepFromLimit(policy.autoPayLimitCents, channelCents));
  const [saving, setSaving] = useState<'idle' | 'saving' | 'saved'>('idle');
  const [error, setError] = useState<ApiClientError | null>(null);
  const excluded = s?.members.find((m) => m.memberId === s.me?.memberId)?.status === 'excluded';
  const limit = limitFromStep(step);
  const mode = paymentMode(limit, channelCents);

  const save = () => {
    if (limit === policy.autoPayLimitCents) return;
    setSaving('saving');
    setError(null);
    trip.client
      .putPolicy({ policy: { ...policy, autoPayLimitCents: limit } })
      .then(() => {
        setSaving('saved');
        trip.refresh();
      })
      .catch((e: unknown) => {
        setSaving('idle');
        setError(toClientError(e));
      });
  };

  const explain =
    mode.kind === 'auto'
      ? `Pays every part after ${windowSeconds} s unless you dispute.`
      : mode.kind === 'ask'
        ? 'Asks you before paying any part.'
        : `Pays parts up to ${formatCents(limit)} after ${windowSeconds} s unless you dispute. Above it, asks you.`;

  return (
    <Section
      footer={
        excluded ? (
          'You were excluded from this trip.'
        ) : saving === 'saving' ? (
          <Working text="Saving…" />
        ) : saving === 'saved' ? (
          'Saved: signed and shared with your agent.'
        ) : (
          explain
        )
      }
    >
      <div className="px-4 pt-3 pb-3">
        <div className="flex min-h-11 items-center justify-between gap-3">
          <span className="text-body">Pay automatically</span>
          <LimitBadge limitCents={limit} channelCents={channelCents} />
        </div>
        <Slider
          value={step}
          max={sliderSteps(channelCents)}
          onChange={(v) => {
            setStep(v);
            setSaving('idle');
          }}
          onCommit={save}
          disabled={excluded || saving === 'saving'}
          label="Limit"
          valueText={mode.long}
        />
        <div className="flex justify-between text-footnote text-label-2">
          <span>always ask</span>
          <span>auto mode</span>
        </div>
        <p className="mt-3 inline-flex rounded-full bg-bg-fill px-3 py-1 text-subhead text-label-2">
          and at most {formatCents(policy.dailyCapCents)} a day
        </p>
        {error && <ErrorNote error={error} className="mt-3" />}
      </div>
    </Section>
  );
}
