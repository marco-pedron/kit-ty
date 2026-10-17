import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { deriveAppSecretHex } from './rln-wallet.js';
import { loadMemberWalletOptions } from './secrets.js';

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
    expect(o).toEqual({
      nodeUrl: 'http://127.0.0.1:3002',
      appSecretHex: deriveAppSecretHex('bob words'),
      assetId: 'rgb:dusd',
    });
    expect(JSON.stringify(o)).not.toMatch(/alice|pw-|treasury/);
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
