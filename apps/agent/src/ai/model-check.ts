import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

// A6, SPEC §13 #19: the model files are checked before they are loaded. Each QVAC model
// constant pins the sha256 of its file (`sha256Checksum`, @qvac/sdk 0.21.0 exactly); a file in
// the local cache that does not match it is never loaded: the AI goes to error and the payer
// uses the manual form. A missing file is an error too: the demo runs offline (SPEC §11).

export interface PinnedModel {
  name: string;
  /** File name in the registry, e.g. "Qwen3-1.7B-Q4_0.gguf". */
  modelId: string;
  sha256Checksum: string;
}

/** QVAC's cache: `cacheDirectory`, default ~/.qvac/models (docs/vendor/QVAC.md, Configuration). */
export function qvacCacheDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.QVAC_CACHE_DIR || join(homedir(), '.qvac', 'models');
}

export function sha256File(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const h = createHash('sha256');
    createReadStream(path)
      .on('data', (c) => h.update(c))
      .on('error', reject)
      .on('end', () => resolve(h.digest('hex')));
  });
}

/** Throws with every problem found; resolves with the checked files. */
export async function verifyModels(models: readonly PinnedModel[], dir: string): Promise<string[]> {
  const files = await readdir(dir).catch(() => [] as string[]);
  const problems: string[] = [];
  const checked: string[] = [];
  for (const m of models) {
    // the cache names a file "<prefix>_<modelId>"
    const found = files.filter((f) => f === m.modelId || f.endsWith(`_${m.modelId}`));
    if (found.length === 0) {
      problems.push(`${m.name}: ${m.modelId} is not in the local cache ${dir}`);
      continue;
    }
    for (const f of found) {
      const sha = await sha256File(join(dir, f));
      if (sha !== m.sha256Checksum)
        problems.push(
          `${m.name}: ${f} has sha256 ${sha.slice(0, 12)}…, expected ${m.sha256Checksum.slice(0, 12)}…`,
        );
      else checked.push(f);
    }
  }
  if (problems.length > 0) throw new Error(`model files rejected: ${problems.join('; ')}`);
  return checked;
}
