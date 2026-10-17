import { Avatar, ScreenHeader } from '../components.js';
import type { ScreenProps } from './types.js';

export function ProfileScreen({ trip, as, go }: ScreenProps) {
  const s = trip.state;
  const name = s?.members.find((m) => m.memberId === as)?.displayName ?? as;
  return (
    <>
      <ScreenHeader title="Profile" back="home" go={go} />
      <div className="flex flex-col items-center gap-2 px-6 pt-8">
        <Avatar m={as} size={96} />
        <p className="mt-2 font-slab text-title font-bold capitalize">{name}</p>
        <button type="button" onClick={() => go('groups')} className="mt-6 font-semibold text-teal">
          Payment limits are set per group
        </button>
      </div>
    </>
  );
}
