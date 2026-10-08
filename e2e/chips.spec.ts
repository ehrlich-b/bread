// Automated browser regressions using palette, visible pins and chip controls.
// Genuine manual construction is recorded separately by the local QA task.
import * as fs from 'node:fs/promises';
import { expect, test, type Page } from '@playwright/test';

const canvas = (page: Page) => page.locator('svg[data-role="canvas"]');
async function place(page: Page, type: string, x: number, y: number): Promise<void> {
  await page.locator(`[data-palette-type="${type}"]`).click();
  await canvas(page).click({ position: { x, y } });
}
async function wire(page: Page, a: string, b: string): Promise<void> {
  await page.locator(`[data-pin="${a}"]`).click();
  await page.locator(`[data-pin="${b}"]`).click();
}
async function createNot(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'New circuit', exact: true }).click();
  await expect(page.locator('[data-comp-id]')).toHaveCount(0);
  await place(page, 'prim.NAND', 180, 100);
  await expect(page.locator('[data-comp-id="nand1"]')).toBeVisible();
  await wire(page, 'nand1.A', 'nand1.B');
  await page.locator('[data-comp-id="nand1"] path.gate-body').click();
  await page.getByRole('button', { name: 'Create chip from selection', exact: true }).click();
  await page.getByRole('textbox', { name: 'Chip name', exact: true }).fill('Not');
  await page.getByRole('textbox', { name: 'Port 1 name', exact: true }).fill('Input');
  await page.getByRole('textbox', { name: 'Port 2 name', exact: true }).fill('Output');
  await page.getByRole('button', { name: 'Create and replace selection', exact: true }).click();
  await expect(page.getByRole('dialog')).not.toBeVisible();
  await expect(page.locator('[data-comp-type="user.Not"]')).toHaveCount(1);
}
test.beforeEach(async ({ page }) => {
  await page.goto('/'); await expect(canvas(page)).toBeVisible();
  await page.getByRole('button', { name: 'Pause', exact: true }).click();
});

test('author an inverter from a NAND and test 0, 1, released and unknown inputs', async ({ page }) => {
  await createNot(page);
  await page.getByRole('button', { name: 'Edit Not', exact: true }).click();
  await expect(page.locator('[data-comp-type="prim.NAND"]')).toHaveCount(1);
  await page.getByRole('button', { name: 'Drive Input 0', exact: true }).click();
  await expect(page.getByLabel('Output value', { exact: true })).toHaveText('1');
  await page.getByRole('button', { name: 'Drive Input 1', exact: true }).click();
  await expect(page.getByLabel('Output value', { exact: true })).toHaveText('0');
  for (const v of ['Z', 'X']) {
    await page.getByRole('button', { name: `Drive Input ${v}`, exact: true }).click();
    await expect(page.getByLabel('Output value', { exact: true })).toHaveText('X');
  }
  await page.getByRole('button', { name: 'Save chip & return', exact: true }).click();
  await expect(page.locator('[data-comp-type="user.Not"]')).toHaveCount(1);
});

test('nested reuse runs and a downloaded project reopens with its full library', async ({ page }) => {
  await createNot(page);
  await place(page, 'user.Not', 400, 100);
  await wire(page, 'not1.Output', 'not2.Input');
  await page.locator('[data-comp-id="not1"] .gate-body').click();
  await page.locator('[data-comp-id="not2"] .gate-body').click({ modifiers: ['Shift'] });
  await page.getByRole('button', { name: 'Create chip from selection', exact: true }).click();
  await page.getByRole('textbox', { name: 'Chip name', exact: true }).fill('Double');
  await page.getByRole('button', { name: 'Create and replace selection', exact: true }).click();
  await expect(page.locator('[data-comp-type="user.Double"]')).toHaveCount(1);
  await page.getByRole('button', { name: 'Edit Double', exact: true }).click();
  await expect(page.locator('[data-comp-type="user.Not"]')).toHaveCount(2);
  await page.getByRole('button', { name: 'Drive Input 0', exact: true }).click();
  await expect(page.getByLabel('Output value', { exact: true })).toHaveText('0');
  await page.getByRole('button', { name: 'Drive Input 1', exact: true }).click();
  await expect(page.getByLabel('Output value', { exact: true })).toHaveText('1');
  await page.getByRole('button', { name: 'Save chip & return', exact: true }).click();
  const pending = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download JSON', exact: true }).click();
  const download = await pending; const path = await download.path(); if (!path) throw new Error('missing download path');
  const text = await fs.readFile(path, 'utf8');
  const saved = JSON.parse(text) as { definitions: Array<{ name: string; metadata: { revision: number } }> };
  expect(saved.definitions.map((d) => d.name)).toEqual(['user.Not', 'user.Double']);
  expect(saved.definitions[1]!.metadata.revision).toBe(2);
  await page.reload(); await expect(canvas(page)).toBeVisible();
  await page.locator('input[data-file-action="load-input"]').setInputFiles(path);
  await expect(page.locator('[data-comp-type="user.Double"]')).toHaveCount(1);
  await expect(page.getByRole('button', { name: 'Edit Not', exact: true })).toBeVisible();
});

test('undo and redo preserve the chip library together with the selected fragment', async ({ page }) => {
  await createNot(page);
  await page.locator('#controls [data-action="undo"]').click();
  await expect(page.locator('[data-comp-type="prim.NAND"]')).toHaveCount(1);
  await expect(page.getByRole('button', { name: 'Edit Not', exact: true })).toHaveCount(0);
  await page.locator('#controls [data-action="redo"]').click();
  await expect(page.locator('[data-comp-type="user.Not"]')).toHaveCount(1);
  await expect(page.getByRole('button', { name: 'Edit Not', exact: true })).toHaveCount(1);
});

test('a breaking port rename keeps a repairable draft and reports the wired instance', async ({ page }) => {
  await createNot(page);
  await page.getByRole('button', { name: 'Edit Not', exact: true }).click();
  await page.getByRole('textbox', { name: 'Edit port 1 name', exact: true }).fill('Renamed');
  await page.getByRole('button', { name: 'Apply ports', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Drive Renamed 0', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Save chip & return', exact: true }).click();
  await expect(page.locator('#chips [role="alert"]')).toHaveText(/unknown port "Input"/);
  await expect(page.getByRole('button', { name: 'Cancel chip edit', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Cancel chip edit', exact: true }).click();
  await expect(page.locator('[data-pin="not1.Input"]')).toBeVisible();
});

test('an internal chip edit propagates to every wired instance', async ({ page }) => {
  await createNot(page);
  await place(page, 'user.Not', 420, 100);
  await place(page, 'io.switch', 80, 280);
  await place(page, 'io.led', 350, 280);
  await place(page, 'io.led', 550, 280);
  await wire(page, 'switch1.Y', 'not1.Input');
  await wire(page, 'not1.Input', 'not2.Input');
  await wire(page, 'not1.Output', 'led1.A');
  await wire(page, 'not2.Output', 'led2.A');
  await page.locator('[data-comp-id="switch1"] [data-role="switch-handle"]').click();
  for (const id of ['led1', 'led2']) await expect(page.locator(`[data-comp-id="${id}"] .led`)).toHaveAttribute('fill', 'var(--led-off)');
  await page.getByRole('button', { name: 'Edit Not', exact: true }).click();
  await page.locator('[data-comp-id="nand1"] path.gate-body').click();
  await page.locator('.inspector-form textarea[data-field="params"]').fill('{"inputs":3}');
  await page.locator('.inspector-form button[data-action="apply"]').click();
  await page.getByRole('button', { name: 'Save chip & return', exact: true }).click();
  // Structural edits reset switch/storage state. Assert behavior after a new input.
  await page.locator('[data-comp-id="switch1"] [data-role="switch-handle"]').click();
  for (const id of ['led1', 'led2']) await expect(page.locator(`[data-comp-id="${id}"] .led`)).toHaveAttribute('fill', 'var(--led-x)');
});

test('visible JSON export contains the actual authored chip library and can reopen', async ({ page }) => {
  await createNot(page);
  await page.getByRole('button', { name: 'Circuit JSON', exact: true }).click();
  const text = page.getByRole('textbox', { name: 'Circuit JSON', exact: true });
  await expect(text).toHaveAttribute('readonly', '');
  const contents = await text.inputValue();
  const parsed = JSON.parse(contents) as { definitions: Array<{ name: string }>; components: Array<{ type: string }> };
  expect(parsed.definitions[0]!.name).toBe('user.Not');
  expect(parsed.components[0]!.type).toBe('user.Not');
  await page.getByRole('button', { name: 'Close JSON', exact: true }).click();
  await page.reload(); await expect(canvas(page)).toBeVisible();
  await page.getByRole('button', { name: 'Paste JSON', exact: true }).click();
  await page.getByRole('textbox', { name: 'Paste circuit JSON', exact: true }).fill(contents);
  await page.getByRole('button', { name: 'Open pasted JSON', exact: true }).click();
  await expect(page.locator('[data-comp-type="user.Not"]')).toHaveCount(1);
});

test('parameterized gates and storage expose their actual pins for wiring', async ({ page }) => {
  await page.getByRole('button', { name: 'New circuit', exact: true }).click();
  await place(page, 'prim.DFF', 200, 100);
  await page.locator('[data-comp-id="dff1"]').click();
  await page.locator('.inspector-form textarea[data-field="params"]').fill('{"clrActiveLow":true,"preActiveLow":true}');
  await page.locator('.inspector-form button[data-action="apply"]').click();
  await expect(page.locator('[data-pin="dff1./CLR"]')).toBeVisible();
  await expect(page.locator('[data-pin="dff1./PRE"]')).toBeVisible();
  await place(page, 'prim.NAND', 380, 100);
  await page.locator('[data-comp-id="nand1"]').click();
  await page.locator('.inspector-form textarea[data-field="params"]').fill('{"inputs":4}');
  await page.locator('.inspector-form button[data-action="apply"]').click();
  await expect(page.locator('[data-pin="nand1.C"]')).toBeVisible();
  await expect(page.locator('[data-pin="nand1.D"]')).toBeVisible();
  await place(page, 'prim.TRISTATE', 200, 300);
  await page.locator('[data-comp-id="tristate1"]').click();
  await page.locator('.inspector-form textarea[data-field="params"]').fill('{"oeActiveLow":true}');
  await page.locator('.inspector-form button[data-action="apply"]').click();
  await expect(page.locator('[data-pin="tristate1./OE"]')).toBeVisible();
  await expect(page.locator('[data-pin="tristate1.OE"]')).toHaveCount(0);
  await wire(page, 'nand1.Y', 'dff1./CLR');
});

test('saving a chip reconciles parent probes, reports the changes and keeps undo coherent', async ({ page }) => {
  const circuit = {
    version: 1, kind: 'circuit', name: 'Probed buffer', components: [{ id: 'u', type: 'user.Buffer' }], nets: [],
    definitions: [{
      version: 1, kind: 'composite', name: 'user.Buffer',
      components: [{ id: 'a', type: 'prim.BUF', position: [180, 100] }, { id: 'b', type: 'prim.BUF', position: [350, 100] }, { id: 'c', type: 'prim.BUF', position: [350, 240] }],
      nets: [{ id: 'in', endpoints: ['a.A'] }, { id: 'middle', endpoints: ['a.Y', 'b.A'] }, { id: 'out', endpoints: ['b.Y'] }, { id: 'spare', endpoints: ['c.Y'] }],
      ports: [{ name: 'IN', dir: 'in', internalNet: 'in' }, { name: 'OUT', dir: 'out', internalNet: 'out' }],
    }],
    probes: [{ id: 'output', label: 'OUT', nets: ['u__out'] }, { id: 'internal', label: 'Internal', nets: ['u__spare'] }],
  };
  await page.locator('input[data-file-action="load-input"]').setInputFiles({ name: 'probed-buffer.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(circuit)) });
  await expect(page.getByLabel('Waveform OUT', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Edit Buffer', exact: true }).click();
  await page.getByRole('button', { name: 'Fit circuit', exact: true }).click();
  await page.getByLabel('Edit port 2 net', { exact: true }).selectOption('middle');
  await page.getByRole('button', { name: 'Apply ports', exact: true }).click();
  for (const id of ['b', 'c']) {
    await page.locator(`[data-comp-id="${id}"] .gate-body`).click();
    await page.locator('.inspector-form button[data-action="delete"]').click();
    await expect(page.locator(`[data-comp-id="${id}"]`)).toHaveCount(0);
  }
  await page.getByRole('button', { name: 'Save chip & return', exact: true }).click();
  await expect(page.locator('#chips [role="status"]')).toContainText('retargeted OUT; removed Internal');
  await expect(page.locator('#chips [role="alert"]')).toHaveCount(0);
  await expect(page.getByLabel('Waveform OUT', { exact: true })).toBeVisible();
  await expect(page.getByLabel('Waveform Internal', { exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Circuit JSON', exact: true }).click();
  const saved = JSON.parse(await page.getByRole('textbox', { name: 'Circuit JSON', exact: true }).inputValue());
  expect(saved.probes).toEqual([{ id: 'output', label: 'OUT', nets: ['u__middle'] }]);
  await page.getByRole('button', { name: 'Close JSON', exact: true }).click();
  await page.locator('#controls [data-action="undo"]').click();
  await expect(page.getByRole('button', { name: 'Save chip & return', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Cancel chip edit', exact: true }).click();
  await expect(page.getByLabel('Waveform Internal', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Circuit JSON', exact: true }).click();
  expect(JSON.parse(await page.getByRole('textbox', { name: 'Circuit JSON', exact: true }).inputValue()).probes).toEqual(circuit.probes);
  await page.getByRole('button', { name: 'Close JSON', exact: true }).click();
});
