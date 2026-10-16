import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ApiClientError, createAgentClient, type FetchLike } from './client.js';
import { TripViewSchema } from './views.js';
import { emptyState } from './test/samples.js';

type Call = { url: string; init?: RequestInit | undefined };

function fakeFetch(status: number, body: unknown, calls: Call[] = []): FetchLike {
  return async (url, init) => {
    calls.push({ url, init });
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });
  };
}

describe('createAgentClient', () => {
  it('fills :as in the path and decodes amounts to bigint', async () => {
    const calls: Call[] = [];
    const client = createAgentClient(
      'http://agent',
      'bob',
      fakeFetch(200, z.encode(TripViewSchema, emptyState), calls),
    );
    const state = await client.getState();
    expect(calls[0]?.url).toBe('http://agent/api/bob/state');
    expect(calls[0]?.init?.method).toBe('GET');
    expect(state.me?.balance?.tripOutboundCents).toBe(5000n);
  });

  it('sends path params and body, with amounts as strings', async () => {
    const calls: Call[] = [];
    const client = createAgentClient('', 'bob', fakeFetch(200, {}, calls));
    await client
      .putPolicy({
        policy: { autoPayLimitCents: 1500n, dailyCapCents: 6000n, payUpheldDisputes: false },
      })
      .catch(() => undefined);
    expect(calls[0]?.url).toBe('/api/bob/policy');
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({
      policy: { autoPayLimitCents: '1500', dailyCapCents: '6000', payUpheldDisputes: false },
    });
    await client
      .decideLine({ id: 'e1', decision: 'contest', reason: 'water only' })
      .catch(() => undefined);
    expect(calls[1]?.url).toBe('/api/bob/expenses/e1/decision');
    expect(JSON.parse(String(calls[1]?.init?.body))).toEqual({
      decision: 'contest',
      reason: 'water only',
    });
  });

  it('refuses coordinator routes for a traveler without calling the agent', async () => {
    const calls: Call[] = [];
    const client = createAgentClient('', 'bob', fakeFetch(200, {}, calls));
    await expect(
      client.coverAndExclude({ expenseId: 'e1', member: 'charlie' }),
    ).rejects.toMatchObject({
      code: 'NOT_ALLOWED',
    });
    expect(calls).toHaveLength(0);
  });

  it('builds dave routes without :as', async () => {
    const calls: Call[] = [];
    const client = createAgentClient('', 'dave', fakeFetch(200, {}, calls));
    await client.coverAndExclude({ expenseId: 'e1', member: 'charlie' }).catch(() => undefined);
    expect(calls[0]?.url).toBe('/api/dave/defaults/e1/charlie/cover-and-exclude');
  });

  it('maps an ApiError body to ApiClientError with its action', async () => {
    const body = { error: { code: 'TOPUP_REQUIRED', message: 'low', action: 'Top up.' } };
    const client = createAgentClient('', 'bob', fakeFetch(409, body));
    const err = await client.getState().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiClientError);
    expect(err).toMatchObject({ code: 'TOPUP_REQUIRED', action: 'Top up.', httpStatus: 409 });
  });

  it('maps a broken response or a network failure to INTERNAL', async () => {
    await expect(
      createAgentClient('', 'bob', fakeFetch(200, { nope: 1 })).getState(),
    ).rejects.toMatchObject({
      code: 'INTERNAL',
    });
    await expect(
      createAgentClient('', 'bob', fakeFetch(500, 'oops')).getState(),
    ).rejects.toMatchObject({
      code: 'INTERNAL',
      httpStatus: 500,
    });
    const down: FetchLike = async () => {
      throw new TypeError('fetch failed');
    };
    await expect(createAgentClient('', 'bob', down).getState()).rejects.toMatchObject({
      code: 'INTERNAL',
      httpStatus: 0,
    });
  });
});
