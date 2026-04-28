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

test('clicking two free pins creates a wire', async ({ page }) => {
  await page.locator('.palette-entry[data-palette-type="prim.OR"]').click();
  await page.locator('svg[data-role="canvas"]').click({ position: { x: 250, y: 50 } });
  await expect(page.locator('[data-comp-id="or1"]')).toBeVisible();

  const before = await page.locator('polyline.wire').count();
  await page.locator('[data-pin="or1.A"]').click();
  await expect(page.locator('[data-pin="or1.A"]')).toHaveClass(/pin-active/);
  await page.locator('[data-pin="or1.B"]').click();

  // A new 2-endpoint net adds exactly one polyline.
  await expect(page.locator('polyline.wire')).toHaveCount(before + 1);
  await expect(page.locator('[data-pin="or1.A"]')).not.toHaveClass(/pin-active/);
});

test('Esc cancels an in-progress wire', async ({ page }) => {
  await page.locator('.palette-entry[data-palette-type="prim.AND"]').click();
  await page.locator('svg[data-role="canvas"]').click({ position: { x: 250, y: 50 } });
  const before = await page.locator('polyline.wire').count();

  await page.locator('[data-pin="and1.A"]').click();
  await expect(page.locator('[data-pin="and1.A"]')).toHaveClass(/pin-active/);
  await page.keyboard.press('Escape');

  await expect(page.locator('[data-pin="and1.A"]')).not.toHaveClass(/pin-active/);
  await expect(page.locator('polyline.wire')).toHaveCount(before);
});

test('extending a net to a third endpoint adds a junction dot', async ({ page }) => {
  // Drop a second LED and tie it onto the existing `lit` net by clicking the
  // current `led.A` pin, then the fresh `led1.A` pin.
  await page.locator('.palette-entry[data-palette-type="io.led"]').click();
  await page.locator('svg[data-role="canvas"]').click({ position: { x: 480, y: 50 } });
  await expect(page.locator('[data-comp-id="led1"]')).toBeVisible();

  await expect(page.locator('circle.junction[data-net-id="lit"]')).toHaveCount(0);
  await page.locator('[data-pin="led.A"]').click();
  await page.locator('[data-pin="led1.A"]').click();

  // Three endpoints (and.Y, led.A, led1.A) → centroid junction dot.
  await expect(page.locator('circle.junction[data-net-id="lit"]')).toHaveCount(1);
  // Polylines for the lit net: one per endpoint = 3 segments.
  await expect(page.locator('polyline.wire[data-net-id="lit"]')).toHaveCount(3);
});
