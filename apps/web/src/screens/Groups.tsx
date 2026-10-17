import { EmptyState, ScreenHeader } from '../components.js';
import type { ScreenProps } from './types.js';

// Groups and Group settings: filled in C4d.

export function GroupsScreen({ trip, go }: ScreenProps) {
  const name = trip.state?.trip?.name;
  return (
    <>
      <ScreenHeader title="Groups" back="home" go={go} />
      {name === undefined ? (
        <EmptyState>Your groups appear here.</EmptyState>
      ) : (
        <button
          type="button"
          onClick={() => go('group')}
          className="mx-4 block w-[calc(100%-2rem)] rounded-2xl bg-white p-4 text-left font-medium shadow-sm"
        >
          {name}
        </button>
      )}
    </>
  );
}

export function GroupSettingsScreen({ trip, go }: ScreenProps) {
  return (
    <>
      <ScreenHeader title={trip.state?.trip?.name ?? 'Group'} back="groups" go={go} />
      <EmptyState>Group settings appear here.</EmptyState>
    </>
  );
}
