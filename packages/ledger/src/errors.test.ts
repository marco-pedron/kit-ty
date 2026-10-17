import { ERROR_ACTIONS, ErrorCodeSchema } from '@kitty/shared';
import { describe, expect, expectTypeOf, it } from 'vitest';
import { LedgerError, type LedgerErrorCode } from './errors.js';

describe('LedgerError', () => {
  it('uses only API error codes, each with a suggested action', () => {
    expectTypeOf<LedgerErrorCode>().toExtend<(typeof ErrorCodeSchema.options)[number]>();
    const e = new LedgerError('TOTAL_MISMATCH', 'items do not add up');
    expect(ErrorCodeSchema.options).toContain(e.code);
    expect(ERROR_ACTIONS[e.code]).toMatch(/total/i);
  });
});
