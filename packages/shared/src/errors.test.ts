import { describe, expect, it } from 'vitest';
import { ERROR_ACTIONS, ErrorCodeSchema } from './errors.js';

describe('error codes', () => {
  it.each([
    'TOPUP_REQUIRED',
    'NODE_UNREACHABLE',
    'INVOICE_EXPIRED',
    'AI_NOT_READY',
    'AGENT_NOT_READY',
    'TOTAL_MISMATCH',
    'NOT_ALLOWED',
    'INVALID_EVENT',
    'NOT_IMPLEMENTED',
  ])('includes %s', (code) => {
    expect(ErrorCodeSchema.options).toContain(code);
  });

  it.each(ErrorCodeSchema.options)('%s has a human action ending with a full stop', (code) => {
    const action = ERROR_ACTIONS[code];
    expect(action.length).toBeGreaterThan(10);
    expect(action).toMatch(/^[A-Z].*\.$/);
    expect(action).not.toMatch(/[A-Z]{2,}_[A-Z]/); // no raw codes in user text
  });
});
