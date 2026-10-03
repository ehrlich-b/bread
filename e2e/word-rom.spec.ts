// Ordinary automated browser regressions. Manual CPU assembly is separate.
import { expect, test, type Page } from '@playwright/test';
const canvas = (page: Page) => page.locator('svg[data-role="canvas"]');
async function place(page: Page, type: string, x: number, y: number) {
  await page.locator(`[data-palette-type="${type}"]`).click(); await canvas(page).click({ position: { x, y } });
}
async function exported(page: Page) {
  await page.getByRole('button', { name: 'Circuit JSON', exact: true }).click();
  const value = await page.getByRole('textbox', { name: 'Circuit JSON', exact: true }).inputValue();
  await page.getByRole('button', { name: 'Close JSON', exact: true }).click(); return value;
}
test.beforeEach(async ({ page }) => {
  await page.goto('/'); await page.getByRole('button', { name: 'Pause', exact: true }).click();
  await page.getByRole('button', { name: 'New circuit', exact: true }).click();
  await expect(page.locator('[data-comp-id]')).toHaveCount(0);
});

test('program a wide control word visibly, reject malformed edits, undo and reopen', async ({ page }) => {
  const errors: string[] = []; page.on('pageerror', (error) => errors.push(error.message));
  await place(page, 'mem.ROM', 220, 220);
  await page.locator('[data-comp-id="rom1"] .gate-body').click();
  const params = page.locator('[data-inspector="rom1"] [data-field="params"]');
  await params.fill(JSON.stringify({ addressBits: 8, dataBits: 29, bitLabels: ['PCOut', 'PCEnable'] }));
  await page.locator('[data-field="contents"]').fill('v2.0 raw\n2001\n8802');
  await page.getByRole('button', { name: 'Apply', exact: true }).click();
  await expect(page.locator('[data-field="word-preview"]')).toContainText('PCOut');
  await page.getByLabel('Preview address', { exact: true }).fill('3');
  await page.getByLabel('Word (hex)', { exact: true }).fill('10042968');
  await page.getByRole('button', { name: 'Set word in draft', exact: true }).click();
  await expect(page.locator('[data-field="word-preview"]')).toContainText('0x10042968');
  await page.getByLabel('Word (hex)', { exact: true }).fill('# comment only');
  await page.getByRole('button', { name: 'Set word in draft', exact: true }).click();
  await expect(page.locator('[data-field="word-preview"]')).toHaveText('Enter one hex word');
  await page.getByRole('button', { name: 'Apply', exact: true }).click();
  const saved = await exported(page);
  expect(JSON.parse(saved).components[0].params.contents.split('\n')[3]).toBe('10042968');
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(page.locator('[data-field="contents"]')).toHaveValue('v2.0 raw\n2001\n8802');
  await page.getByLabel('Preview address', { exact: true }).fill('3');
  await expect(page.getByLabel('Word (hex)', { exact: true })).toHaveValue('00000000');
  await page.getByRole('button', { name: 'Redo', exact: true }).click();
  await expect(page.locator('[data-field="contents"]')).toHaveValue(/10042968/);
  for (const invalid of ['1', 'true', '"text"', '[]', 'null']) {
    await params.fill(invalid); await page.getByRole('button', { name: 'Apply', exact: true }).click();
    await expect(page.locator('.inspector-status')).toContainText('Params must be a JSON object');
  }
  expect(errors).toEqual([]);
  await page.reload(); await expect(canvas(page)).toBeVisible();
  await page.getByRole('button', { name: 'Paste JSON', exact: true }).click();
  await page.getByRole('textbox', { name: 'Paste circuit JSON', exact: true }).fill(saved);
  await page.getByRole('button', { name: 'Open pasted JSON', exact: true }).click();
  await page.locator('[data-comp-id="rom1"] .gate-body').click();
  await page.getByLabel('Preview address', { exact: true }).fill('3');
  await expect(page.locator('[data-field="word-preview"]')).toContainText('0x10042968');
});

test('connect a visible byte bus with explicit mapping and one undo', async ({ page }) => {
  await place(page, 'mem.ROM', 170, 180); await place(page, 'prim.MUX2', 450, 260);
  await page.locator('[data-comp-id="mux21"] .gate-body').click();
  await page.locator('[data-field="params"]').fill('{"width":8}');
  await page.getByRole('button', { name: 'Apply', exact: true }).click();
  await page.getByRole('button', { name: 'Connect bus', exact: true }).click();
  await page.locator('[data-pin="rom1.D0"]').click(); await page.locator('[data-pin="mux21.A0"]').click();
  const dialog = page.getByRole('dialog', { name: 'Connect bus', exact: true });
  await expect(dialog).toBeVisible(); await expect(dialog.getByLabel('Bus width')).toHaveValue('8');
  await expect(dialog.locator('li').last()).toHaveText('rom1.D7 → mux21.A7');
  await dialog.getByRole('button', { name: 'Connect these bits', exact: true }).focus();
  await page.keyboard.press('Delete'); await page.keyboard.press('r'); await page.keyboard.press('Meta+z');
  await expect(dialog).toBeVisible(); await expect(page.locator('[data-comp-id]')).toHaveCount(2);
  await dialog.getByRole('button', { name: 'Cancel bus', exact: true }).click();
  expect(JSON.parse(await exported(page)).nets).toHaveLength(0);
  await page.locator('[data-pin="rom1.D0"]').click(); await page.locator('[data-pin="mux21.A0"]').click();
  await dialog.getByRole('button', { name: 'Connect these bits', exact: true }).click();
  await expect(dialog).not.toBeVisible();
  expect(JSON.parse(await exported(page)).nets).toHaveLength(8);
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  expect(JSON.parse(await exported(page)).nets).toHaveLength(0);
  await page.getByRole('button', { name: 'Redo', exact: true }).click();
  expect(JSON.parse(await exported(page)).nets).toHaveLength(8);
});

test('live bytes show read data, released output and floating-address unknowns', async ({ page }) => {
  await place(page, 'mem.ROM', 230, 210);
  await page.locator('[data-comp-id="rom1"] .gate-body').click();
  await page.locator('[data-field="params"]').fill('{"addressBits":2,"dataBits":8}');
  await page.locator('[data-field="contents"]').fill('2A');
  await page.getByRole('button', { name: 'Apply', exact: true }).click();
  await place(page, 'prim.CONST_0', 70, 100); await place(page, 'io.switch', 90, 370);
  for (const target of ['rom1.A0', 'rom1.A1']) {
    await page.locator('[data-pin="const_01.Y"]').click(); await page.locator(`[data-pin="${target}"]`).click();
  }
  await page.locator('[data-pin="switch1.Y"]').click(); await page.locator('[data-pin="rom1.SEL"]').click();
  await page.locator('[data-comp-id="rom1"] .gate-body').click();
  await expect(page.getByLabel('Live D[7:0]', { exact: true })).toContainText('ZZZZZZZZ');
  await page.locator('[data-comp-id="switch1"] .switch-handle').click();
  await expect(page.getByLabel('Live D[7:0]', { exact: true })).toContainText('2A');
  await expect(page.getByLabel('Live D[7:0]', { exact: true })).toContainText('00101010');
  await page.locator('[data-comp-id="const_01"] .gate-body').click();
  await page.getByRole('button', { name: 'Delete', exact: true }).click();
  await expect(page.locator('[data-comp-id="const_01"]')).toHaveCount(0);
  // Structural edits reset runtime switch values, as they reset storage.
  await page.locator('[data-comp-id="switch1"] .switch-handle').click();
  await page.locator('[data-comp-id="rom1"] .gate-body').click();
  await expect(page.getByLabel('Live D[7:0]', { exact: true })).toContainText('XXXXXXXX');
  await expect(page.getByLabel('Live A[1:0]', { exact: true })).toContainText('ZZ');
});
