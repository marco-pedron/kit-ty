import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// pnpm e2e:close only. IRREVERSIBLE: closes charlie's real channels on the regtest stack.
// Its own config and file suffix, so neither `pnpm test` nor `pnpm e2e:wallet` can pick it up.
export default defineConfig({
  test: {
    root: fileURLToPath(new URL('.', import.meta.url)),
    include: ['**/*.destructive.ts'],
    testTimeout: 180_000,
    hookTimeout: 30_000,
    fileParallelism: false,
    reporters: ['verbose'],
    silent: false,
  },
});
