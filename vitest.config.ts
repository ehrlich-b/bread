import { configDefaults, defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  resolve: {
    alias: process.env.BREAD_TEST_BACKEND === 'truth-table' ? [{
      find: /^.*\/sim$/,
      replacement: fileURLToPath(new URL('./src/engine/__fixtures__/truth-table-entry.ts', import.meta.url)),
    }] : [],
  },
  test: {
    minWorkers: 1,
    exclude: [...configDefaults.exclude, 'e2e/**', '.scratch/**'],
  },
});
