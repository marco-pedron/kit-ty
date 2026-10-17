import { describe, expect, it } from 'vitest';
import { buildRelay } from './server.js';

describe('relay skeleton', () => {
  it('answers /health', async () => {
    const app = buildRelay();
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, service: 'relay' });
    await app.close();
  });
});
