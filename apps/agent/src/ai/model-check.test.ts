import { createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { qvacCacheDir, verifyModels } from './model-check.js';

const sha = (s: string) => createHash('sha256').update(s).digest('hex');

function cache(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'kitty-models-'));
  for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content);
  return dir;
}

const llm = {
  name: 'QWEN3_1_7B_INST_Q4',
  modelId: 'Qwen3-1.7B-Q4_0.gguf',
  sha256Checksum: sha('weights'),
};

describe('verifyModels (A6, SPEC §13 #19)', () => {
  it('accepts a cached file whose sha256 matches the pinned one', async () => {
    const dir = cache({ 'f7cce66406dee646_Qwen3-1.7B-Q4_0.gguf': 'weights' });
    expect(await verifyModels([llm], dir)).toEqual(['f7cce66406dee646_Qwen3-1.7B-Q4_0.gguf']);
  });

  it('rejects a tampered file', async () => {
    const dir = cache({ 'f7cce66406dee646_Qwen3-1.7B-Q4_0.gguf': 'weights, tampered' });
    await expect(verifyModels([llm], dir)).rejects.toThrow(/QWEN3_1_7B_INST_Q4: .* has sha256/);
  });

  it('rejects a missing file: the demo runs offline', async () => {
    await expect(verifyModels([llm], cache({}))).rejects.toThrow(/not in the local cache/);
  });

  it('uses QVAC_CACHE_DIR, else ~/.qvac/models', () => {
    expect(qvacCacheDir({ QVAC_CACHE_DIR: '/data/m' })).toBe('/data/m');
    expect(qvacCacheDir({})).toMatch(/\.qvac\/models$/);
  });
});
