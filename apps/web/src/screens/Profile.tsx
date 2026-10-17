import { DEFAULT_POLICY } from '@kitty/shared';
import { ScreenHeader } from '../components.js';
import { paymentMode } from '../mode.js';
import type { ScreenProps } from './types.js';

export function ProfileScreen({ trip, as, go }: ScreenProps) {
  const s = trip.state;
  const name = s?.members.find((m) => m.memberId === as)?.displayName ?? as;
  const limit = (s?.me?.policy ?? DEFAULT_POLICY).autoPayLimitCents;
  const mode = s?.trip ? paymentMode(limit, s.trip.params.tripChannelCents) : null;
  return (
    <>
      <ScreenHeader title="Profile" back="home" go={go} />
      <div className="flex flex-col items-center gap-2 px-6 pt-8">
        <div className="grid size-24 place-items-center rounded-full bg-pink-100 text-4xl font-semibold text-pink-700 uppercase">
          {name.slice(0, 1)}
        </div>
        <p className="mt-2 text-xl font-semibold capitalize">{name}</p>
        <div className="mt-6 w-full rounded-2xl bg-white p-4 shadow-sm">
          <p className="text-xs font-medium tracking-wide text-gray-500 uppercase">Payment mode</p>
          <p className="mt-1 font-medium">{mode?.long ?? 'Not set yet'}</p>
          <button
            type="button"
            onClick={() => go('group')}
            className="mt-2 text-sm font-medium text-pink-700"
          >
            Change in group settings
          </button>
        </div>
      </div>
    </>
  );
}
