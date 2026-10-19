import { qvacCacheDir, verifyModels } from '../model-check.js';

// globalSetup of pnpm ai:test: the suite runs the real on-device models, so it stops before
// any test with one clear message when they are not in the local QVAC cache (or not the pinned
// files), instead of failing every receipt with a load error.

export default async function modelsPresent(): Promise<void> {
  const sdk = await import('@qvac/sdk').catch((e: unknown) => {
    throw new Error(`pnpm ai:test: @qvac/sdk cannot be loaded on this machine (${String(e)}).`, {
      cause: e,
    });
  });
  const dir = qvacCacheDir();
  try {
    await verifyModels([sdk.OCR_LATIN, sdk.OCR_CRAFT, sdk.QWEN3_1_7B_INST_Q4], dir);
  } catch (e) {
    throw new Error(
      [
        'pnpm ai:test needs the on-device models in the local QVAC cache, and they are not usable:',
        `  ${(e as Error).message}`,
        `Cache: ${dir} (set QVAC_CACHE_DIR to use another one).`,
        'Download them once with the network on: pnpm ai:eval (the SDK fetches them on first load).',
      ].join('\n'),
      { cause: e },
    );
  }
}
