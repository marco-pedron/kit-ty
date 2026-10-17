import {
  ApiClientError,
  createAgentClient,
  type ActorId,
  type AgentClient,
  type TripView,
} from '@kitty/shared';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { POLL_MS } from './config.js';

// The one source of what the UI shows: GET /api/:as/state, polled every second (SPEC §14).
// Actions call the agent through the same typed client, then `refresh()` so the result shows
// at once instead of on the next tick.

export interface TripState {
  client: AgentClient;
  state: TripView | null;
  /** The last /state failure, cleared by the next success. */
  error: ApiClientError | null;
  /** serverNow − browser clock, in ms: countdowns follow the server, not the browser. */
  clockOffsetMs: number;
  refresh: () => void;
}

export function toClientError(e: unknown): ApiClientError {
  return e instanceof ApiClientError
    ? e
    : new ApiClientError('INTERNAL', String(e), 'Reload the page.', 0);
}

export function useTripState(as: ActorId): TripState {
  const client = useMemo(() => createAgentClient('', as), [as]);
  const [state, setState] = useState<TripView | null>(null);
  const [error, setError] = useState<ApiClientError | null>(null);
  const [clockOffsetMs, setClockOffsetMs] = useState(0);
  const alive = useRef(true);

  const refresh = useCallback(() => {
    client
      .getState()
      .then((s) => {
        if (!alive.current) return;
        setState(s);
        setError(null);
        setClockOffsetMs(Date.parse(s.serverNow) - Date.now());
      })
      .catch((e: unknown) => {
        if (alive.current) setError(toClientError(e));
      });
  }, [client]);

  useEffect(() => {
    alive.current = true;
    refresh();
    const id = setInterval(refresh, POLL_MS);
    return () => {
      alive.current = false;
      clearInterval(id);
    };
  }, [refresh]);

  return { client, state, error, clockOffsetMs, refresh };
}
