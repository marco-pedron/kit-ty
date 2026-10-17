import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// Integration tests against the Docker regtest stack (pnpm e2e:wallet). Kept out of
// `pnpm test`: their files end in .integration.ts, which the default include ignores.
export default defineConfig({
  test: {
    root: fileURLToPath(new URL('.', import.meta.url)),
    include: ['**/*.integration.ts'],
    testTimeout: 90_000,
    hookTimeout: 30_000,
    fileParallelism: false,
  },
});
