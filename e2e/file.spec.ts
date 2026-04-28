// Save/load round-trip tests. The FS Access API is removed via addInitScript
// so the controls fall through to the `<a download>` and `<input type=file>`
// fallbacks — those are deterministic for Playwright. The FS Access path
// shares the same JSON serialization, so testing the fallback covers both.

import * as fs from 'node:fs/promises';
import { expect, test } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    delete (window as unknown as { showSaveFilePicker?: unknown }).showSaveFilePicker;
    delete (window as unknown as { showOpenFilePicker?: unknown }).showOpenFilePicker;
  });
  await page.goto('/');
  await expect(page.locator('svg[data-role="canvas"]')).toBeVisible();
});

test('Save downloads circuit JSON matching current state', async ({ page }) => {
  const downloadPromise = page.waitForEvent('download');
  await page.locator('button[data-file-action="save"]').click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe('blink_demo.json');
  const path = await download.path();
  if (!path) throw new Error('download has no path');
  const content = await fs.readFile(path, 'utf8');
  const parsed = JSON.parse(content) as {
    name: string;
    components: unknown[];
    nets: unknown[];
  };
  expect(parsed.name).toBe('blink_demo');
  expect(parsed.components).toHaveLength(4);
  expect(parsed.nets).toHaveLength(3);
});

test('Load replaces the current circuit with file contents', async ({ page }) => {
  const customCircuit = {
    version: 1,
    kind: 'circuit',
    name: 'custom',
    components: [
      { id: 'sw1', type: 'io.switch', position: [40, 60] },
      { id: 'led1', type: 'io.led', position: [200, 60] },
    ],
    nets: [{ id: 'n1', endpoints: ['sw1.Y', 'led1.A'] }],
  };
  await page.locator('input[data-file-action="load-input"]').setInputFiles({
    name: 'custom.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(customCircuit)),
  });
  await expect(page.locator('[data-comp-id]')).toHaveCount(2);
  await expect(page.locator('[data-comp-id="sw1"]')).toBeVisible();
  await expect(page.locator('[data-comp-id="led1"]')).toBeVisible();
  await expect(page.locator('[data-comp-id="sw"]')).toHaveCount(0);
});

test('Save then load round-trips a fresh edit', async ({ page }) => {
  await page.locator('.palette-entry[data-palette-type="prim.OR"]').click();
  await page.locator('svg[data-role="canvas"]').click({ position: { x: 300, y: 200 } });
  await expect(page.locator('[data-comp-id="or1"]')).toBeVisible();

  const downloadPromise = page.waitForEvent('download');
  await page.locator('button[data-file-action="save"]').click();
  const download = await downloadPromise;
  const path = await download.path();
  if (!path) throw new Error('download has no path');
  const content = await fs.readFile(path, 'utf8');

  await page.reload();
  await expect(page.locator('svg[data-role="canvas"]')).toBeVisible();
  await expect(page.locator('[data-comp-id="or1"]')).toHaveCount(0);

  await page.locator('input[data-file-action="load-input"]').setInputFiles({
    name: 'restored.json',
    mimeType: 'application/json',
    buffer: Buffer.from(content),
  });
  await expect(page.locator('[data-comp-id="or1"]')).toBeVisible();
});
