import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// OCR accuracy suite on the real on-device models (pnpm ai:test). Kept out of `pnpm test` and
// CI: its files end in .accuracy.ts, which the default include ignores, and the models are not
// there. The models are loaded once: one worker, files never in parallel, generous timeouts.
export default defineConfig({
  test: {
    root: fileURLToPath(new URL('.', import.meta.url)),
    include: ['**/*.accuracy.ts'],
    globalSetup: ['./models-present.ts'],
    fileParallelism: false,
    maxWorkers: 1,
    // loading the models (sha256 of every file, then load): minutes on a cold disk
    hookTimeout: 600_000,
    // one judge call, or one extraction with its retry
    testTimeout: 300_000,
  },
});
