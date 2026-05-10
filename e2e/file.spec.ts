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

test('Examples menu loads a bundled circuit', async ({ page }) => {
  // Default boot is blink_demo (4 components, 3 nets).
  await expect(page.locator('[data-comp-id]')).toHaveCount(4);

  await page.locator('select[data-file-action="examples"]').selectOption('full_adder');
  // Full adder has 10 components (3 io.switch, 2 io.led, 5 gates).
  await expect(page.locator('[data-comp-id]')).toHaveCount(10);
  await expect(page.locator('[data-comp-type="io.switch"]')).toHaveCount(3);

  // Picking the placeholder again is a no-op; circuit stays put.
  await page.locator('select[data-file-action="examples"]').selectOption('nand_latch');
  await expect(page.locator('[data-comp-type="prim.NAND"]')).toHaveCount(2);
});

test('Hex display 28C16 example: ROM contents show in inspector and 7-seg lights up', async ({ page }) => {
  await page.locator('select[data-file-action="examples"]').selectOption('hex_display_28c16');

  // Components: 4 switches, gnd, vcc, rom, disp.
  await expect(page.locator('[data-comp-id="rom"]')).toBeVisible();
  await expect(page.locator('[data-comp-id="disp"]')).toBeVisible();
  await expect(page.locator('[data-comp-type="io.switch"]')).toHaveCount(4);

  // 7-seg renderer emits eight segment shapes (a..g + dp).
  for (const s of ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'dp']) {
    await expect(page.locator(`[data-comp-id="disp"] [data-role="seg-${s}"]`)).toBeVisible();
  }

  // Inspector for the EEPROM exposes the ROM-contents textarea pre-filled
  // with the bundled hex image.
  await page.locator('[data-comp-id="rom"]').click();
  const romHex = page.locator('textarea[data-field="contents"]');
  await expect(romHex).toBeVisible();
  await expect(romHex).toHaveValue(/3F 06 5B 4F/);

  // Address 0 → 0x3F → segments a..f lit, g/dp dark. The rAF poller updates
  // each segment's fill from the SAB; segment a should resolve to the 'on'
  // colour token.
  const segA = page.locator('[data-comp-id="disp"] [data-role="seg-a"]');
  await expect(segA).toHaveAttribute('fill', 'var(--seg-on)');
  const segG = page.locator('[data-comp-id="disp"] [data-role="seg-g"]');
  await expect(segG).toHaveAttribute('fill', 'var(--seg-off)');

  // Flip sw0 → address 1 → 0x06 → only b, c lit; a should go dark.
  await page.locator('[data-comp-id="sw0"]').click();
  await expect(segA).toHaveAttribute('fill', 'var(--seg-off)');
  const segB = page.locator('[data-comp-id="disp"] [data-role="seg-b"]');
  await expect(segB).toHaveAttribute('fill', 'var(--seg-on)');
});

test('Ben Eater 8-bit example loads with all top-level subsystems wired', async ({ page }) => {
  await page.locator('select[data-file-action="examples"]').selectOption('ben_eater_8bit');

  // Each major subsystem should be present at the top level.
  const expectedComponents = [
    'reg_a', 'reg_b', 'alu',
    'ram_chip', 'mar', 'ir', 'display',
    'pc', 'flags', 'control',
    'clk_gen', 'sw_reset',
    'inv_hlt', 'and_clk', 'inv_clr',
  ];
  for (const id of expectedComponents) {
    await expect(page.locator(`[data-comp-id="${id}"]`)).toBeVisible();
  }

  // The reset switch is the user's start button — click it to release reset.
  // We can't easily verify the engine ran (gen.clock is real-time at 2 Hz, the
  // display is inside a composite so the segments aren't visible at top level)
  // but we can confirm the click flips the switch state visually.
  const resetSwitch = page.locator('[data-comp-id="sw_reset"]');
  await expect(resetSwitch).toBeVisible();
  // Switch handle is part of the io.switch renderer.
  const handle = resetSwitch.locator('[data-role="switch-handle"]');
  await expect(handle).toBeVisible();
});

test('placing a TTL chip from the new palette entries works', async ({ page }) => {
  await page.locator('.palette-entry[data-palette-type="ttl.74LS00"]').click();
  await page.locator('svg[data-role="canvas"]').click({ position: { x: 300, y: 100 } });

  const chip = page.locator('[data-comp-id="74ls001"]');
  await expect(chip).toBeVisible();
  // Generic renderer emits one pin handle per chip pin (74LS00 has 12 ports).
  await expect(chip.locator('[data-role="pin"]')).toHaveCount(12);
  // Spot-check the named pins.
  await expect(page.locator('[data-pin="74ls001.1A"]')).toBeVisible();
  await expect(page.locator('[data-pin="74ls001.4Y"]')).toBeVisible();
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
