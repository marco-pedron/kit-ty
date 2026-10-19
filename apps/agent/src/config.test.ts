import { describe, expect, it } from 'vitest';
import { loadConfig, nodeUrls } from './config.js';

describe('loadConfig', () => {
  it('defaults to the demo: real wallet, ln-2ch, timers of SPEC §15, localhost only', () => {
    const c = loadConfig({});
    expect(c).toMatchObject({
      KITTY_FAKES: false,
      KITTY_RAIL_MODE: 'ln-2ch',
      KITTY_WALLET_ENGINE: 'rln-rest',
      AGENT_HOST: '127.0.0.1',
      AGENT_PORT: 4100,
      SILENT_ASSENT_SECONDS: 45,
      PAYMENT_DEADLINE_SECONDS: 120,
      INVOICE_EXPIRY_SECONDS: 3600,
      KITTY_STT_LANGUAGE: 'en',
    });
    expect(() => loadConfig({ KITTY_STT_LANGUAGE: 'fr' })).toThrow(/KITTY_STT_LANGUAGE/);
    expect(nodeUrls(c).dave).toBe('http://127.0.0.1:3004');
  });

  it('reads overrides and rejects bad values', () => {
    expect(loadConfig({ KITTY_FAKES: '1', SILENT_ASSENT_SECONDS: '5' })).toMatchObject({
      KITTY_FAKES: true,
      SILENT_ASSENT_SECONDS: 5,
    });
    expect(() => loadConfig({ KITTY_RAIL_MODE: 'mainnet' })).toThrow(/KITTY_RAIL_MODE/);
    expect(() => loadConfig({ KITTY_FAKES: 'yes' })).toThrow(/KITTY_FAKES/);
    expect(() => loadConfig({ RELAY_URL: 'not a url' })).toThrow(/RELAY_URL/);
  });
});
