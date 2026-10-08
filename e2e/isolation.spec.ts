import { expect, test } from './fixtures';
import { routeDist } from './in_memory';

test('missing isolation headers show an actionable alert before starting the worker', async ({ page, context }) => {
  test.skip(process.env.BREAD_E2E_IN_MEMORY !== '1', 'Requires built files served without isolation headers');
  await routeDist(context, false);
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto('/');
  expect(await page.evaluate(() => self.crossOriginIsolated)).toBe(false);
  const alert = page.getByRole('alert');
  await expect(alert).toBeVisible();
  await expect(alert).toContainText('Bread cannot start');
  await expect(alert).toContainText('cross-origin isolation');
  await expect(alert).toContainText('Cross-Origin-Opener-Policy: same-origin');
  await expect(alert).toContainText('Cross-Origin-Embedder-Policy: require-corp');
  await expect(page.getByRole('button', { name: 'Run', exact: true })).toHaveCount(0);
  expect(page.workers()).toHaveLength(0);
  expect(errors).toEqual([]);
});
