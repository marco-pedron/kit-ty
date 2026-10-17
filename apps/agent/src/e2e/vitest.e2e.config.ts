import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// pnpm e2e:demo (and the other e2e scenarios) only. IRREVERSIBLE on the regtest stack: run
// `pnpm demo:reset` first. Its own config and file suffix, so `pnpm test` never picks it up.
export default defineConfig({
  test: {
    root: fileURLToPath(new URL('.', import.meta.url)),
    include: ['**/*.e2e.ts'],
    testTimeout: 180_000,
    hookTimeout: 150_000,
    fileParallelism: false,
    sequence: { concurrent: false },
    bail: 1,
    reporters: ['verbose'],
    silent: false,
  },
});
