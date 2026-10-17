import { TripViewSchema } from '@kitty/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { loadConfig } from './config.js';
import { buildAgentServer } from './server.js';

afterEach(() => vi.unstubAllEnvs());

async function state(as: string, env: Record<string, string> = {}) {
  const app = buildAgentServer(loadConfig(env), {
    now: () => new Date('2026-10-17T12:00:00.000Z'),
  });
  const res = await app.inject({ method: 'GET', url: `/api/${as}/state` });
  await app.close();
  return res;
}

describe('agent skeleton', () => {
  it('answers /health', async () => {
    const app = buildAgentServer(loadConfig({}));
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.json()).toEqual({ ok: true, service: 'agent', fakes: false });
    await app.close();
  });

  it('serves a TripView that decodes with the shared schema', async () => {
    const res = await state('bob');
    expect(res.statusCode).toBe(200);
    const view = z.decode(TripViewSchema, res.json());
    expect(view).toMatchObject({ as: 'bob', role: 'traveler', fakes: false, coordinator: null });
    expect(view.me?.memberId).toBe('bob');
  });

  it('a traveler never receives the coordinator view; dave does', async () => {
    for (const as of ['alice', 'bob', 'charlie']) {
      const view = z.decode(TripViewSchema, (await state(as)).json());
      expect(view.coordinator).toBeNull();
    }
    const dave = z.decode(TripViewSchema, (await state('dave')).json());
    expect(dave).toMatchObject({ role: 'coordinator', me: null });
    expect(dave.coordinator).not.toBeNull();
  });

  it('reports fakes on /state when KITTY_FAKES=1', async () => {
    vi.stubEnv('KITTY_FAKES', '1');
    const view = z.decode(TripViewSchema, (await state('alice', { KITTY_FAKES: '1' })).json());
    expect(view.fakes).toBe(true);
    expect(view.ai).toEqual({ status: 'ready', fake: true });
  });

  it('answers unknown members and routes with an ApiError', async () => {
    const res = await state('nobody');
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toMatchObject({ code: 'NOT_FOUND' });
  });
});
