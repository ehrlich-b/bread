// 1-bit full adder demo. Loads examples/full_adder.json into the editor,
// drives the three input switches across all 8 combinations, and verifies
// the Sum and Cout LEDs reflect the truth-table output. Demonstrates the
// editor-built circuit pipeline from save/load through the worker engine.

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { expect, test, type Page } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('svg[data-role="canvas"]')).toBeVisible();
  // Load the adder via the file input fallback.
  await page.locator('input[data-file-action="load-input"]').setInputFiles(
    path.resolve('examples/full_adder.json'),
  );
  await expect(page.locator('[data-comp-id="led_sum"]')).toBeVisible();
  await expect(page.locator('[data-comp-id="led_cout"]')).toBeVisible();
});

const setSwitch = async (page: Page, id: string, target: 0 | 1): Promise<void> => {
  const label = page.locator(`[data-comp-id="${id}"] [data-role="switch-label"]`);
  const cur = Number(await label.textContent());
  if (cur !== target) {
    await page.locator(`[data-comp-id="${id}"]`).click();
  }
  await expect(label).toHaveText(String(target));
};

const expectLed = async (page: Page, id: string, on: boolean): Promise<void> => {
  const fill = page.locator(`[data-comp-id="${id}"] [data-role="led"]`);
  await expect
    .poll(() => fill.getAttribute('fill'), { timeout: 2_000, intervals: [25, 50, 100] })
    .toMatch(on ? /led-on/ : /led-off/);
};

test('the example file is a valid CircuitJSON for our IR', async () => {
  const buf = await fs.readFile(path.resolve('examples/full_adder.json'), 'utf8');
  const json = JSON.parse(buf) as { components: unknown[]; nets: unknown[] };
  expect(json.components).toHaveLength(10);
  expect(json.nets).toHaveLength(8);
});

test('renders 10 components and the input switches default to 0', async ({ page }) => {
  await expect(page.locator('[data-comp-id]')).toHaveCount(10);
  await expect(page.locator('[data-comp-id="a"] [data-role="switch-label"]')).toHaveText('0');
  await expect(page.locator('[data-comp-id="b"] [data-role="switch-label"]')).toHaveText('0');
  await expect(page.locator('[data-comp-id="cin"] [data-role="switch-label"]')).toHaveText('0');
  await expectLed(page, 'led_sum', false);
  await expectLed(page, 'led_cout', false);
});

test('all 8 input combinations match the full-adder truth table', async ({ page }) => {
  for (let combo = 0; combo < 8; combo++) {
    const a = ((combo >> 2) & 1) as 0 | 1;
    const b = ((combo >> 1) & 1) as 0 | 1;
    const c = (combo & 1) as 0 | 1;
    const sum = (a ^ b ^ c) & 1;
    const cout = (a & b) | ((a ^ b) & c);

    await setSwitch(page, 'a', a);
    await setSwitch(page, 'b', b);
    await setSwitch(page, 'cin', c);

    await expectLed(page, 'led_sum', sum === 1);
    await expectLed(page, 'led_cout', cout === 1);
  }
});
