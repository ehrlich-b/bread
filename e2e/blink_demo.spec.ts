// Browser-side smoke test of the M3 demo. Mirrors scripts/blink_demo.ts but
// drives the real Vite dev server through Chromium so the SVG schematic, the
// switch click handler, the worker round-trip, and the SAB-driven LED updates
// are all exercised end-to-end.

import { expect, test } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('svg[data-role="canvas"]')).toBeVisible();
  expect(await page.evaluate(() => self.crossOriginIsolated)).toBe(true);
});

test('schematic renders four components and three wires', async ({ page }) => {
  await expect(page.locator('[data-comp-id]')).toHaveCount(4);
  await expect(page.locator('polyline.wire')).toHaveCount(3);
  // Controls panel has Run, Pause, Step plus Undo/Redo.
  await expect(page.locator('#controls button', { hasText: 'Run' })).toHaveCount(1);
  await expect(page.locator('#controls button', { hasText: 'Pause' })).toHaveCount(1);
  await expect(page.locator('#controls button', { hasText: 'Step' })).toHaveCount(1);
});

test('switch click toggles label and handle color', async ({ page }) => {
  const sw = page.locator('[data-comp-id="sw"]');
  const label = sw.locator('[data-role="switch-label"]');
  const handle = sw.locator('[data-role="switch-handle"]');

  await expect(label).toHaveText('0');
  await expect(handle).toHaveAttribute('fill', /led-off/);

  await sw.click();
  await expect(label).toHaveText('1');
  await expect(handle).toHaveAttribute('fill', /led-on/);

  await sw.click();
  await expect(label).toHaveText('0');
  await expect(handle).toHaveAttribute('fill', /led-off/);
});

test('LED stays off while switch=0 and blinks when switch=1', async ({ page }) => {
  const sw = page.locator('[data-comp-id="sw"]');
  const led = page.locator('[data-comp-id="led"] [data-role="led"]');

  // freqHz=1 at rateHz=1000 → toggle every ~500ms. With switch=0 the AND
  // output is 0 regardless of clock, so the LED must stay off.
  await page.waitForTimeout(1500);
  await expect(led).toHaveAttribute('fill', /led-off/);

  await sw.click();

  // Now the LED should follow the clock — observe both states within ~3s.
  await expect
    .poll(() => led.getAttribute('fill'), { timeout: 3_000, intervals: [50, 100, 200] })
    .toMatch(/led-on/);
  await expect
    .poll(() => led.getAttribute('fill'), { timeout: 3_000, intervals: [50, 100, 200] })
    .toMatch(/led-off/);
});

test('Pause stops LED updates', async ({ page }) => {
  const sw = page.locator('[data-comp-id="sw"]');
  await sw.click(); // switch on so the LED is actively cycling

  // Wait for the LED to be on, then pause.
  const led = page.locator('[data-comp-id="led"] [data-role="led"]');
  await expect.poll(() => led.getAttribute('fill'), { timeout: 3_000 }).toMatch(/led-on/);

  await page.locator('#controls button', { hasText: 'Pause' }).click();

  const frozen = await led.getAttribute('fill');
  await page.waitForTimeout(1500);
  expect(await led.getAttribute('fill')).toBe(frozen);
});
