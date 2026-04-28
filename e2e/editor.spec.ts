// Editor surface area: palette, click-to-place. The blink demo is the default
// circuit on first load; these tests add components on top of it.

import { expect, test } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('svg[data-role="canvas"]')).toBeVisible();
});

test('palette renders all entries grouped by category', async ({ page }) => {
  await expect(page.locator('.palette-group')).toHaveCount(3);
  await expect(page.locator('.palette-entry')).toHaveCount(12);
  // Spot-check a few.
  await expect(page.locator('.palette-entry[data-palette-type="prim.AND"]')).toHaveText('AND');
  await expect(page.locator('.palette-entry[data-palette-type="io.led"]')).toHaveText('LED');
  await expect(page.locator('.palette-entry[data-palette-type="prim.DFF"]')).toHaveText('DFF');
});

test('clicking a palette entry toggles aria-pressed', async ({ page }) => {
  const orBtn = page.locator('.palette-entry[data-palette-type="prim.OR"]');
  await expect(orBtn).toHaveAttribute('aria-pressed', 'false');
  await orBtn.click();
  await expect(orBtn).toHaveAttribute('aria-pressed', 'true');
  await orBtn.click();
  await expect(orBtn).toHaveAttribute('aria-pressed', 'false');
});

test('selecting a different palette entry switches placement', async ({ page }) => {
  const andBtn = page.locator('.palette-entry[data-palette-type="prim.AND"]');
  const orBtn = page.locator('.palette-entry[data-palette-type="prim.OR"]');
  await andBtn.click();
  await expect(andBtn).toHaveAttribute('aria-pressed', 'true');
  await orBtn.click();
  await expect(andBtn).toHaveAttribute('aria-pressed', 'false');
  await expect(orBtn).toHaveAttribute('aria-pressed', 'true');
});

test('palette + canvas click places a new component', async ({ page }) => {
  // M3 demo loads with 4 components — we are placing one more.
  await expect(page.locator('[data-comp-id]')).toHaveCount(4);
  await expect(page.locator('[data-comp-id="or1"]')).toHaveCount(0);

  await page.locator('.palette-entry[data-palette-type="prim.OR"]').click();
  await page.locator('svg[data-role="canvas"]').click({ position: { x: 200, y: 50 } });

  await expect(page.locator('[data-comp-id="or1"]')).toBeVisible();
  await expect(page.locator('[data-comp-id]')).toHaveCount(5);
  // Placement clears after the click.
  await expect(page.locator('.palette-entry[data-palette-type="prim.OR"]')).toHaveAttribute(
    'aria-pressed',
    'false',
  );
});

test('placing two of the same type generates distinct ids', async ({ page }) => {
  const andBtn = page.locator('.palette-entry[data-palette-type="prim.NAND"]');
  await andBtn.click();
  await page.locator('svg[data-role="canvas"]').click({ position: { x: 150, y: 30 } });
  await expect(page.locator('[data-comp-id="nand1"]')).toBeVisible();

  await andBtn.click();
  await page.locator('svg[data-role="canvas"]').click({ position: { x: 350, y: 30 } });
  await expect(page.locator('[data-comp-id="nand2"]')).toBeVisible();
});

test('placement does not toggle a switch when clicking on it', async ({ page }) => {
  // Switch label is "0" at start.
  await expect(page.locator('[data-comp-id="sw"] [data-role="switch-label"]')).toHaveText('0');

  // Enter placement mode and click on the switch — placement should win,
  // a new LED should appear, and the switch must remain in state 0.
  await page.locator('.palette-entry[data-palette-type="io.led"]').click();
  await page.locator('[data-comp-id="sw"]').click();

  await expect(page.locator('[data-comp-id="led1"]')).toBeVisible();
  await expect(page.locator('[data-comp-id="sw"] [data-role="switch-label"]')).toHaveText('0');
});
