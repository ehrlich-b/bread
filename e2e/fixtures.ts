import { test as base } from '@playwright/test';
import { routeDist } from './in_memory';

export { expect, type CDPSession, type Locator, type Page } from '@playwright/test';
export const test = base.extend<{ distRoutes: void }>({
  distRoutes: [async ({ context }, use) => {
    if (process.env.BREAD_E2E_IN_MEMORY === '1') await routeDist(context);
    await use();
  }, { auto: true }],
});
