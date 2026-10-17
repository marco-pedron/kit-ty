import { ErrorCodeSchema } from '@kitty/shared';
import { describe, expect, it } from 'vitest';
import { HUMAN_ERRORS, humanError } from './errors.js';

describe('every error code has a human sentence and a next step', () => {
  it('covers every code of the contract', () => {
    for (const code of ErrorCodeSchema.options) {
      const h = HUMAN_ERRORS[code];
      expect(h, code).toBeDefined();
      expect(h.title.length).toBeGreaterThan(10);
      expect(h.action.length).toBeGreaterThan(5);
    }
  });

  it('never shows a raw code', () => {
    for (const code of ErrorCodeSchema.options) {
      const h = HUMAN_ERRORS[code];
      expect(`${h.title} ${h.action}`).not.toMatch(/\b[A-Z]+_[A-Z_]+\b/);
    }
  });

  it('says the agent cannot be reached when the request never left', () => {
    expect(humanError({ code: 'INTERNAL', httpStatus: 0 })).toMatchObject({
      title: "Can't reach your agent.",
      retry: true,
    });
    expect(humanError({ code: 'INTERNAL', httpStatus: 500 }).title).toBe(
      'Something went wrong on your phone.',
    );
  });

  it('names whose node is not answering', () => {
    expect(humanError({ code: 'RECEIVER_UNREACHABLE', httpStatus: 503 }, 'Bob')).toMatchObject({
      title: "Bob's node is not answering.",
      action: 'Try again in a few seconds.',
    });
  });

  it('offers a retry only where trying again can work', () => {
    expect(humanError({ code: 'PAYMENT_FAILED', httpStatus: 502 }).retry).toBe(true);
    expect(humanError({ code: 'TOTAL_MISMATCH', httpStatus: 400 }).retry).toBe(false);
  });
});
