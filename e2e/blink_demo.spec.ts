// Browser-side smoke test of the M3 demo. Mirrors scripts/blink_demo.ts but
// drives the real Vite dev server through Chromium so the SVG schematic, the
// switch click handler, the worker round-trip, and the SAB-driven LED updates
// are all exercised end-to-end.

import { expect, test } from './fixtures';

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

test('a manual switch keeps its drive across selection and bus modes, then resets on structural edits', async ({ page }) => {
  await page.getByRole('button', { name: 'Pause', exact: true }).click();
  const sw = page.locator('[data-comp-id="sw"]');
  const label = sw.locator('[data-role="switch-label"]');
  const output = page.locator('[data-net-id="sw_out"]');
  await sw.locator('[data-role="switch-handle"]').click();
  await expect(output).toHaveClass('wire wire-1');
  await page.getByRole('button', { name: 'Connect bus', exact: true }).click();
  await expect(label).toHaveText('1');
  await page.getByRole('button', { name: 'Connect bus', exact: true }).click();
  await sw.click({ modifiers: ['Shift'] });
  await expect(label).toHaveText('1');
  await sw.locator('[data-role="switch-handle"]').click();
  await expect(output).toHaveClass('wire wire-0');
  await sw.locator('[data-role="switch-handle"]').click();
  await expect(output).toHaveClass('wire wire-1');
  await page.locator('[data-comp-id="and"] .gate-body').click();
  await page.keyboard.press('r');
  await expect(output).toHaveClass('wire wire-0');
  await expect(label).toHaveText('0');
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

test('tick-rate control reports achieved throughput and rejects an invalid rate', async ({ page }) => {
  await page.getByRole('button', { name: 'Pause', exact: true }).click();
  const throughput = page.getByLabel('Simulation throughput');
  await expect(throughput).toContainText('Paused');
  const rate = page.getByRole('spinbutton', { name: 'Simulation ticks per second' });
  await rate.fill('20000');
  await page.getByRole('button', { name: 'Run', exact: true }).click();
  await expect(throughput).toContainText('requested 20,000 ticks/s');
  await expect.poll(async () => Number((await throughput.textContent())?.match(/measured ([\d,]+) ticks\/s/)?.[1]?.replaceAll(',', ''))).toBeGreaterThan(1000);
  await page.getByRole('button', { name: 'Pause', exact: true }).click();
  await expect(throughput).toContainText('measured 0 ticks/s');
  const ticks = async (): Promise<number> => Number((await throughput.textContent())?.match(/· ([\d,]+) ticks$/)?.[1]?.replaceAll(',', ''));
  const before = await ticks();
  await page.getByRole('button', { name: 'Step', exact: true }).click();
  await expect.poll(ticks).toBe(before + 1);
  await rate.fill('0'); await page.getByRole('button', { name: 'Run', exact: true }).click();
  await expect(page.locator('#controls [role="alert"]')).toContainText('integer from 1');
  await expect(throughput).toContainText('Paused');
});
