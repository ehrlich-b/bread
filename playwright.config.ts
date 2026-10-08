import { defineConfig, devices } from '@playwright/test';
import { IN_MEMORY_ORIGIN } from './e2e/in_memory';

const inMemory = process.env.BREAD_E2E_IN_MEMORY === '1';

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: 'list',
  use: {
    baseURL: inMemory ? IN_MEMORY_ORIGIN : 'http://127.0.0.1:5187',
    // Avoid trace file I/O in the serverless mode; --trace can still enable it.
    trace: inMemory ? 'off' : 'retain-on-failure',
    // Low-priority headless runs need no display frame cap for actionability.
    launchOptions: inMemory ? { args: ['--disable-frame-rate-limit'] } : undefined,
  },
  webServer: inMemory ? undefined : {
    // Own the test server; port 5173 may belong to another local project.
    command: 'npm run dev -- --host 127.0.0.1 --port 5187 --strictPort',
    url: 'http://127.0.0.1:5187',
    reuseExistingServer: false,
    timeout: 60_000,
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
