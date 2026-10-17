import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { DecisionRequestSchema, routes, type RouteDef } from './api.js';
import { TripViewSchema } from './views.js';
import { emptyState } from './test/samples.js';

const all = Object.entries(routes) as [string, RouteDef][];

describe('route table (SPEC §14.3)', () => {
  it('has exactly the routes of the SPEC', () => {
    expect(all.map(([, r]) => `${r.method} ${r.path}`).sort()).toEqual(
      [
        'GET /api/:as/state',
        'POST /api/:as/expenses/extract',
        'POST /api/:as/expenses/split',
        'POST /api/:as/expenses',
        'POST /api/:as/expenses/:id/decision',
        'POST /api/:as/expenses/:id/void',
        'PUT /api/:as/policy',
        'POST /api/dave/disputes/:expenseId/:member',
        'POST /api/dave/defaults/:expenseId/:member/cover-and-exclude',
        'PUT /api/dave/rates',
        'GET /api/proof/:paymentHash',
      ].sort(),
    );
  });

  it.each(all)('%s: every path param has a schema and vice versa', (_name, r) => {
    const inPath = [...r.path.matchAll(/:(\w+)/g)].map((m) => m[1]).sort();
    expect(Object.keys(r.params?.shape ?? {}).sort()).toEqual(inPath);
  });

  it.each(all)('%s: /api/dave routes are coordinator-only, the others are not', (_name, r) => {
    if (r.path.startsWith('/api/dave/')) expect(r.roles).toEqual(['coordinator']);
    else expect(r.roles).toContain('traveler');
  });

  it('GETs have no body', () => {
    for (const [, r] of all) if (r.method === 'GET') expect(r.body).toBeUndefined();
  });
});

describe('wire schemas', () => {
  it('TripView survives encode → JSON → decode', () => {
    const wire = JSON.parse(JSON.stringify(z.encode(TripViewSchema, emptyState)));
    expect(wire.me.balance.tripOutboundCents).toBe('5000');
    expect(z.decode(TripViewSchema, wire)).toEqual(emptyState);
  });

  it('a contest needs a reason, an approval does not', () => {
    expect(DecisionRequestSchema.safeParse({ decision: 'approve' }).success).toBe(true);
    expect(DecisionRequestSchema.safeParse({ decision: 'contest' }).success).toBe(false);
    expect(
      DecisionRequestSchema.safeParse({ decision: 'contest', reason: 'water only' }).success,
    ).toBe(true);
  });
});
