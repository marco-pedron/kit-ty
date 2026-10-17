import { DEFAULT_POLICY, formatCents, type ApiClientError } from '@kitty/shared';
import { useState } from 'react';
import { EmptyState, ErrorBox, ScreenHeader } from '../components.js';
import { SHOW_DEMO_SECOND_GROUP } from '../config.js';
import { paymentMode } from '../mode.js';
import {
  limitFromStep,
  memberStanding,
  sliderSteps,
  stepFromLimit,
  type MemberStanding,
} from '../slider.js';
import { toClientError } from '../state.js';
import { DEMO_SECOND_GROUP } from './group-history.js';
import type { ScreenProps } from './types.js';

// Groups (PM prototype): each group with my balance and my limit, "Join group" not available
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
          <button
            type="button"
            onClick={() => go('group')}
            className="block w-full rounded-2xl bg-white p-4 text-left shadow-sm"
          >
            <p className="font-semibold">{s.trip.name}</p>
            <p className="mt-1 flex justify-between text-sm text-gray-600">
              <span className="tabular-nums">
                {balance === null ? '—' : formatCents(balance.tripOutboundCents)} DUSD
              </span>
              <span>{paymentMode(limit, s.trip.params.tripChannelCents).short}</span>
            </p>
          </button>
        )}
        {SHOW_DEMO_SECOND_GROUP && (
          <div
            aria-hidden
            className="pointer-events-none rounded-2xl bg-white p-4 opacity-40 grayscale select-none"
          >
            <p className="font-semibold">{DEMO_SECOND_GROUP.name}</p>
            <p className="mt-2 flex justify-between">
              <span className="h-3 w-20 rounded bg-gray-200" />
              <span className="h-3 w-16 rounded bg-gray-200" />
            </p>
          </div>
        )}
        <button
          type="button"
          disabled
          className="w-full rounded-full border border-gray-300 py-3 text-sm font-medium text-gray-400"
        >
          Join group… <span className="text-xs">(soon)</span>
        </button>
      </div>
    </>
  );
}

const STANDING: Record<MemberStanding, { label: string; className: string }> = {
  active: { label: 'active', className: 'bg-green-100 text-green-800' },
  insolvent: { label: 'insolvent', className: 'bg-red-100 text-red-800' },
  excluded: { label: 'excluded', className: 'bg-gray-200 text-gray-600' },
  joining: { label: 'joining', className: 'bg-amber-100 text-amber-800' },
};

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
      <div className="space-y-4 px-4">
        <LimitSlider trip={trip} as={as} go={go} />
        <section className="rounded-2xl bg-white p-4 shadow-sm">
          <h2 className="text-sm font-semibold">Members</h2>
          <ul className="mt-2 divide-y divide-gray-100">
            {s.members.map((m) => {
              const st = STANDING[memberStanding(m, s.expenses)];
              return (
                <li key={m.memberId} className="flex items-center justify-between py-2 text-sm">
                  <span className="capitalize">
                    {m.displayName}
                    {m.memberId === as && <span className="text-gray-400"> (you)</span>}
                  </span>
                  <span className={`rounded-full px-2 py-0.5 text-xs ${st.className}`}>
                    {st.label}
                  </span>
                </li>
              );
            })}
          </ul>
        </section>
        <p className="px-1 text-xs text-gray-500">
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

  return (
    <section className="rounded-2xl bg-white p-4 shadow-sm">
      <h2 className="text-sm font-semibold">Payments by your agent</h2>
      <p className="mt-2 text-lg font-semibold">{mode.long}</p>
      <input
        type="range"
        min={0}
        max={sliderSteps(d)}
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
        className="mt-3 w-full accent-pink-600"
      />
      <div className="flex justify-between text-xs text-gray-500">
        <span>Always ask me</span>
        <span>Automatic payment</span>
      </div>
      <p className="mt-3 text-sm text-gray-600">
        and at most <span className="font-medium">{formatCents(policy.dailyCapCents)} DUSD</span> a
        day
      </p>
      <p className="mt-2 h-4 text-xs text-gray-500">
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
