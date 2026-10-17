import {
  ActorIdSchema,
  ApiClientError,
  createAgentClient,
  type ActorId,
  type TripView,
} from '@kitty/shared';
import { useEffect, useMemo, useState } from 'react';

// Skeleton (contract session): the role from ?as=, /state polled every second.
// Screens are tasks C4-C7.

function actorFromUrl(): ActorId | null {
  const r = ActorIdSchema.safeParse(new URLSearchParams(window.location.search).get('as'));
  return r.success ? r.data : null;
}

export function App() {
  const as = actorFromUrl();
  if (!as) {
    return (
      <main className="mx-auto max-w-sm p-4 font-sans">
        <h1 className="text-xl font-semibold">kit+ty</h1>
        <p className="mt-2 text-sm">Open as one of:</p>
        <ul className="mt-2 flex gap-3 text-sm underline">
          {ActorIdSchema.options.map((a) => (
            <li key={a}>
              <a href={`?as=${a}`}>{a}</a>
            </li>
          ))}
        </ul>
      </main>
    );
  }
  return <Phone as={as} />;
}

function Phone({ as }: { as: ActorId }) {
  const client = useMemo(() => createAgentClient('', as), [as]);
  const [state, setState] = useState<TripView | null>(null);
  const [error, setError] = useState<ApiClientError | null>(null);

  useEffect(() => {
    let alive = true;
    const tick = () => {
      client
        .getState()
        .then((s) => {
          if (!alive) return;
          setState(s);
          setError(null);
        })
        .catch((e: unknown) => {
          if (!alive) return;
          setError(
            e instanceof ApiClientError
              ? e
              : new ApiClientError('INTERNAL', String(e), 'Reload the page.', 0),
          );
        });
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [client]);

  return (
    <main className="mx-auto max-w-sm p-4 font-sans">
      {state?.fakes && (
        <div className="mb-3 rounded bg-amber-200 px-3 py-2 text-sm font-semibold text-amber-900">
          Fakes on: simulated wallet and AI, no real RGB transactions
        </div>
      )}
      <h1 className="text-xl font-semibold">kit+ty</h1>
      <p className="mt-1 text-sm text-gray-600">
        Signed in as <span className="font-medium">{as}</span>
        {state && ` (${state.role})`}
      </p>
      {error && (
        <div className="mt-3 rounded bg-red-100 px-3 py-2 text-sm text-red-900">
          <p>{error.message}</p>
          <p className="font-medium">{error.action}</p>
        </div>
      )}
      {state && <p className="mt-3 text-sm">{state.trip ? state.trip.name : 'No trip yet.'}</p>}
    </main>
  );
}
