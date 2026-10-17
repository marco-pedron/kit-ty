import { ScreenHeader } from '../components.js';
import type { ScreenProps } from './types.js';

export function ProfileScreen({ trip, as, go }: ScreenProps) {
  const s = trip.state;
  const name = s?.members.find((m) => m.memberId === as)?.displayName ?? as;
  return (
    <>
      <ScreenHeader title="Profile" back="home" go={go} />
      <div className="flex flex-col items-center gap-2 px-6 pt-8">
        <div className="grid size-24 place-items-center rounded-full bg-pink-100 text-4xl font-semibold text-pink-700 uppercase">
          {name.slice(0, 1)}
        </div>
        <p className="mt-2 text-xl font-semibold capitalize">{name}</p>
        <button
          type="button"
          onClick={() => go('groups')}
          className="mt-6 text-sm font-medium text-pink-700"
        >
          Payment limits are set per group
        </button>
      </div>
    </>
  );
}
