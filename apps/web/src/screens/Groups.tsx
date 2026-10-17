import { DEFAULT_POLICY, formatCents, type ApiClientError } from '@kitty/shared';
import { useState } from 'react';
import { Avatar, Badge, EmptyState, ErrorBox, LimitBadge, ScreenHeader } from '../components.js';
import { SHOW_DEMO_SECOND_GROUP } from '../config.js';
import { paymentMode } from '../mode.js';
import { limitFromStep, memberStanding, sliderSteps, stepFromLimit } from '../slider.js';
import { toClientError } from '../state.js';
import { DEMO_SECOND_GROUP } from './group-history.js';
import type { ScreenProps } from './types.js';

// Groups (PM prototype): each group with my balance and its limit badge (tap: the slider), "Join group" not available
// yet. Group settings: the one limit slider, the daily cap read-only, the members.

export function GroupsScreen({ trip, go }: ScreenProps) {
  const s = trip.state;
  const balance = s?.me?.balance ?? null;
  const limit = (s?.me?.policy ?? DEFAULT_POLICY).autoPayLimitCents;
  return (
    <>
      <ScreenHeader title="Groups" back="home" go={go} />
      <div className="space-y-3 px-4">
        {s?.trip == null ? (
          <EmptyState>Your groups appear here.</EmptyState>
        ) : (
          <div className="card flex items-center gap-3">
            <button type="button" onClick={() => go('group')} className="min-w-0 flex-1 text-left">
              <p className="truncate font-slab text-amount font-bold">{s.trip.name}</p>
              <p className="amount mt-1 text-ink-muted">
                {balance === null ? '—' : formatCents(balance.tripOutboundCents)} DUSD
              </p>
            </button>
            <LimitBadge
              limitCents={limit}
              channelCents={s.trip.params.tripChannelCents}
              onClick={() => go('group')}
            />
          </div>
        )}
        {SHOW_DEMO_SECOND_GROUP && (
          <div aria-hidden className="card pointer-events-none text-ink-muted select-none">
            <p className="flex items-center justify-between font-slab text-amount font-bold">
              {DEMO_SECOND_GROUP.name}
              <span className="badge bg-line text-ink-muted">Limit</span>
            </p>
            <p className="mt-2 h-3 w-20 rounded-full bg-line" />
          </div>
        )}
        <button type="button" disabled className="btn btn-secondary w-full py-3">
          Join group… <span className="text-small">(soon)</span>
        </button>
      </div>
    </>
  );
}

export function GroupSettingsScreen({ trip, as, go }: ScreenProps) {
  const s = trip.state;
  if (s?.trip == null || s.me === null) {
    return (
      <>
        <ScreenHeader title="Group" back="groups" go={go} />
        <EmptyState>Waiting for dave to set up the trip.</EmptyState>
      </>
    );
  }
  const { params } = s.trip;
  return (
    <>
      <ScreenHeader title={s.trip.name} back="groups" go={go} />
      <div className="space-y-3 px-4">
        <LimitSlider trip={trip} as={as} go={go} />
        <section className="card">
          <h2 className="text-amount">Members</h2>
          <ul className="mt-2 divide-y-[1.5px] divide-line">
            {s.members.map((m) => {
              const st = memberStanding(m, s.expenses);
              return (
                <li key={m.memberId} className="flex items-center justify-between py-2">
                  <span className="flex items-center gap-3 capitalize">
                    <Avatar m={m.memberId} size={32} />
                    {m.displayName}
                    {m.memberId === as && <span className="text-ink-muted"> (you)</span>}
                  </span>
                  <Badge kind={st}>{st}</Badge>
                </li>
              );
            })}
          </ul>
        </section>
        <p className="px-1 text-small text-ink-muted">
          Disputes are open for {params.silentAssentSeconds} s after you see an expense; parts above
          your limit wait for your approval up to {params.paymentDeadlineSeconds} s.
        </p>
      </div>
    </>
  );
}

/** Saved on release, as one signed POLICY_UPDATED; the daily cap is sent back unchanged. */
function LimitSlider({ trip }: ScreenProps) {
  const s = trip.state!;
  const policy = s.me!.policy;
  const d = s.trip!.params.tripChannelCents;
  const [step, setStep] = useState(() => stepFromLimit(policy.autoPayLimitCents, d));
  const [saving, setSaving] = useState<'idle' | 'saving' | 'saved'>('idle');
  const [error, setError] = useState<ApiClientError | null>(null);
  const excluded = s.members.find((m) => m.memberId === s.me!.memberId)?.status === 'excluded';
  const mode = paymentMode(limitFromStep(step), d);

  const save = () => {
    const limit = limitFromStep(step);
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

  const max = sliderSteps(d);
  const filled = max === 0 ? 0 : (step / max) * 100;
  return (
    <section className="card">
      <h2 className="text-amount">Payments by your agent</h2>
      <p className="mt-2 flex h-7 items-center">
        {mode.kind === 'auto' ? (
          <Badge kind="auto">Auto mode</Badge>
        ) : (
          <span className="font-semibold">{mode.long}</span>
        )}
      </p>
      <div className="relative mt-3 h-7" data-noswipe>
        <div className="absolute inset-x-0 top-1/2 h-2 -translate-y-1/2 rounded-full bg-line" />
        <div
          className="absolute top-1/2 left-0 h-2 -translate-y-1/2 rounded-full bg-teal"
          style={{ width: `${filled}%` }}
        />
        <input
          type="range"
          min={0}
          max={max}
          step={1}
          value={step}
          disabled={excluded || saving === 'saving'}
          onChange={(e) => {
            setStep(e.target.valueAsNumber);
            setSaving('idle');
          }}
          onPointerUp={save}
          onKeyUp={save}
          aria-label="Limit"
          aria-valuetext={mode.long}
          className="range-input relative"
        />
      </div>
      <div className="mt-1 flex justify-between text-small text-ink-muted">
        <span>Always ask me</span>
        <span>Automatic payment</span>
      </div>
      <p className="mt-3 text-ink-muted">
        and at most{' '}
        <span className="font-semibold text-ink">{formatCents(policy.dailyCapCents)} DUSD</span> a
        day
      </p>
      <p className="mt-2 h-4 text-small text-ink-muted">
        {excluded
          ? 'You were excluded from this trip.'
          : saving === 'saving'
            ? 'Saving…'
            : saving === 'saved'
              ? 'Saved: signed and shared with your agent.'
              : ''}
      </p>
      {error && <ErrorBox error={error} />}
    </section>
  );
}
