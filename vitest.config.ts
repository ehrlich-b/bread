import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    minWorkers: 1,
    exclude: [...configDefaults.exclude, 'e2e/**', '.scratch/**'],
  },
});
