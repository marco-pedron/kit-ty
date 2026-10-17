import { describe, expect, it } from 'vitest';
import { isRlnErrorBody, toRlnError } from './errors.js';

describe('toRlnError', () => {
  it('keeps the name of an { error, code, name } body', () => {
    const e = toRlnError('/sendpayment', 403, {
      error: 'Node is locked',
      code: 403,
      name: 'LockedNode',
    });
    expect(e.rlnName).toBe('LockedNode');
    expect(e.status).toBe(403);
    expect(e.detail).toBe('Node is locked');
  });

  it.each([
    ['text', 'Internal Server Error'],
    ['null', null],
    ['undefined', undefined],
    ['partial body', { error: 'x', name: 'LockedNode' }],
    ['wrong types', { error: 1, code: '403', name: ['LockedNode'] }],
    ['array', [1, 2]],
  ])('maps a %s body to Unknown without throwing', (_label, body) => {
    const e = toRlnError('/nodeinfo', 500, body);
    expect(e.rlnName).toBe('Unknown');
    expect(isRlnErrorBody(body)).toBe(false);
  });

  it('survives a body that cannot be stringified', () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(toRlnError('/nodeinfo', 500, cyclic).rlnName).toBe('Unknown');
  });
});
