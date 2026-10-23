import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { deriveAppSecretHex } from './rln-wallet.js';
import { loadMemberMnemonic, loadMemberWalletOptions } from './secrets.js';

const dir = mkdtempSync(join(tmpdir(), 'kitty-secrets-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const secretsFile = join(dir, 'nodes.json');
const seedStateFile = join(dir, 'seed-state.json');
writeFileSync(
  secretsFile,
  JSON.stringify({
    nodes: {
      alice: { password: 'pw-alice', mnemonic: 'alice words' },
      bob: { password: 'pw-bob', mnemonic: 'bob words' },
      dave: { password: 'pw-dave', mnemonic: 'dave words' },
    },
    treasuryMnemonic: 'treasury words',
  }),
);
writeFileSync(seedStateFile, JSON.stringify({ assetId: 'rgb:dusd' }));

describe('loadMemberWalletOptions', () => {
  it("returns only that member's node URL, app key and the asset", () => {
    const o = loadMemberWalletOptions('bob', {
      nodeUrl: 'http://127.0.0.1:3002',
      secretsFile,
      seedStateFile,
    });
    const { backup, ...rest } = o;
    expect(rest).toEqual({
      nodeUrl: 'http://127.0.0.1:3002',
      appSecretHex: deriveAppSecretHex('bob words'),
      assetId: 'rgb:dusd',
    });
    expect(JSON.stringify(rest)).not.toMatch(/alice|pw-|treasury/);
    // B6: bob's own password only, to back up and unlock his own node
    expect(backup?.password).toBe('pw-bob');
    expect(backup?.unlockBody).toMatchObject({ password: 'pw-bob', announce_alias: 'bob' });
    expect(backup?.hostDir).toMatch(/infra\/data\/backups\/bob$/);
    expect(JSON.stringify(backup)).not.toMatch(/alice|pw-alice|pw-dave|treasury/);
  });

  it('gives the chain tools that close channels to dave only (B7)', () => {
    const at = { secretsFile, seedStateFile, esploraUrl: 'http://127.0.0.1:3010/' };
    expect(loadMemberWalletOptions('bob', { nodeUrl: 'http://x', ...at }).coordinator).toBe(
      undefined,
    );
    const dave = loadMemberWalletOptions('dave', { nodeUrl: 'http://x', ...at });
    expect(dave.coordinator?.esplora.baseUrl).toBe('http://127.0.0.1:3010');
    expect(dave.coordinator?.miner).toBeDefined();
  });

  it('fails clearly for a member with no secrets or a missing file', () => {
    expect(() =>
      loadMemberWalletOptions('charlie', { nodeUrl: 'http://x', secretsFile, seedStateFile }),
    ).toThrow(/no node mnemonic for charlie/);
    expect(() =>
      loadMemberWalletOptions('bob', {
        nodeUrl: 'http://x',
        secretsFile: join(dir, 'nope.json'),
        seedStateFile,
      }),
    ).toThrow(/demo:reset/);
  });
});

describe('loadMemberMnemonic', () => {
  it("returns only that member's mnemonic", () => {
    expect(loadMemberMnemonic('bob', secretsFile)).toBe('bob words');
    expect(() => loadMemberMnemonic('charlie', secretsFile)).toThrow(
      /no node mnemonic for charlie/,
    );
  });
});
