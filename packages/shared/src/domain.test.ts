import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  DEFAULT_POLICY,
  DEMO_TRIP_PARAMS,
  PolicySchema,
  ReceiptResultSchema,
  ReceiptSchema,
  SplitProposalSchema,
  TripParamsSchema,
} from './domain.js';
import { dinner } from './test/samples.js';

describe('domain schemas', () => {
  it('has the defaults of SPEC §8 and §15', () => {
    expect(z.encode(PolicySchema, DEFAULT_POLICY)).toEqual({
      autoPayLimitCents: '2000',
      dailyCapCents: '6000',
      payUpheldDisputes: false,
    });
    const p = z.encode(TripParamsSchema, DEMO_TRIP_PARAMS);
    expect(p).toMatchObject({
      railMode: 'ln-2ch',
      tripChannelCents: '5000',
      liquidityCents: '3000',
      guaranteeCapCents: '5000',
      channelCapacitySat: '1000000',
      silentAssentSeconds: 20,
      paymentDeadlineSeconds: 30,
      invoiceExpirySeconds: 3600,
    });
  });

  it('round-trips the demo receipt', () => {
    const wire = JSON.parse(JSON.stringify(z.encode(ReceiptSchema, dinner)));
    expect(wire.total).toBe('255000');
    expect(z.decode(ReceiptSchema, wire)).toEqual(dinner);
  });

  it('a fractional quantity is a validation error, not a crash (retry → manual form)', () => {
    const wire = JSON.parse(JSON.stringify(z.encode(ReceiptSchema, dinner)));
    wire.items[0].quantity = 0.5;
    const r = ReceiptSchema.safeParse(wire);
    expect(r.success).toBe(false);
    expect(r.error?.issues[0]?.path).toEqual(['items', 0, 'quantity']);
  });

  it('split proposals name travelers only', () => {
    const ok = { assignments: [{ itemIndex: 0, members: ['alice', 'bob'] }], unassigned: [] };
    expect(SplitProposalSchema.safeParse(ok).success).toBe(true);
    const dave = { assignments: [{ itemIndex: 0, members: ['dave'] }], unassigned: [] };
    expect(SplitProposalSchema.safeParse(dave).success).toBe(false);
    const nobody = { assignments: [{ itemIndex: 0, members: [] }], unassigned: [] };
    expect(SplitProposalSchema.safeParse(nobody).success).toBe(false);
  });

  it('AiResult carries the partial receipt for the manual form', () => {
    const failed = {
      ok: false,
      partial: { merchant: 'Pho Corner' },
      error: 'items: expected array',
      attempts: 2,
      latencyMs: 4100,
    } as const;
    expect(ReceiptResultSchema.safeParse(failed).success).toBe(true);
  });
});
