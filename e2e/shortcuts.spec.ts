import { expect, test, type Page } from './fixtures';

const canvas = (page: Page) => page.locator('svg[data-role="canvas"]');
const metrics = (page: Page) => page.getByLabel('Simulation throughput', { exact: true });
const unfocus = async (page: Page): Promise<void> => { await page.locator('h1').click(); };
const place = async (page: Page): Promise<void> => {
  await page.locator('.palette-entry[data-palette-type="prim.OR"]').click();
  await canvas(page).click({ position: { x: 300, y: 50 } });
  await expect(page.locator('[data-comp-id="or1"]')).toBeVisible();
};

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await expect(canvas(page)).toBeVisible();
  await expect(metrics(page)).toContainText('Running');
});

test('Space pauses and resumes; period advances exactly one paused tick', async ({ page }) => {
  await unfocus(page);
  await page.keyboard.press('Space');
  await expect(metrics(page)).toContainText('Paused');
  const text = await metrics(page).textContent();
  const ticks = Number(/· ([\d,]+) ticks$/.exec(text!)![1]!.replace(/,/g, ''));
  await page.keyboard.press('.');
  await expect(metrics(page)).toContainText(`· ${(ticks + 1).toLocaleString('en-US')} ticks`);
  await expect(metrics(page)).toContainText('Paused');
  await page.keyboard.press('Space');
  await expect(metrics(page)).toContainText('Running');
});

for (const modifier of ['Control', 'Meta']) {
  test(`${modifier}+Z and ${modifier}+Shift+Z undo and redo`, async ({ page }) => {
    await place(page);
    await unfocus(page);
    await page.keyboard.press(`${modifier}+KeyZ`);
    await expect(page.locator('[data-comp-id="or1"]')).toHaveCount(0);
    await page.keyboard.press(`${modifier}+Shift+KeyZ`);
    await expect(page.locator('[data-comp-id="or1"]')).toBeVisible();
    await page.keyboard.press(`${modifier}+KeyZ`);
    await expect(page.locator('[data-comp-id="or1"]')).toHaveCount(0);
    await page.keyboard.press('Control+KeyY');
    await expect(page.locator('[data-comp-id="or1"]')).toBeVisible();
  });
}

for (const key of ['Delete', 'Backspace']) {
  test(`${key} removes the selection and R rotates it`, async ({ page }) => {
    await place(page);
    const component = page.locator('[data-comp-id="or1"]');
    await component.click();
    await page.keyboard.press('r');
    await expect(component).toHaveAttribute('transform', /rotate\(90/);
    await page.keyboard.press('Shift+KeyR');
    await expect(component).toHaveAttribute('transform', /rotate\(180/);
    await page.keyboard.press(key);
    await expect(component).toHaveCount(0);
  });
}

test('Escape cancels placement, net/bus probes and bus wiring', async ({ page }) => {
  const palette = page.locator('.palette-entry[data-palette-type="prim.OR"]');
  await palette.click();
  await page.keyboard.press('Escape');
  await expect(palette).toHaveAttribute('aria-pressed', 'false');
  for (const name of ['Probe net', 'Probe bus', 'Connect bus']) {
    const button = page.getByRole('button', { name, exact: true });
    await button.click();
    await expect(button).toHaveAttribute('aria-pressed', 'true');
    await page.keyboard.press('Escape');
    await expect(button).toHaveAttribute('aria-pressed', 'false');
  }
});

test('F fits the circuit; question mark opens keyboard help', async ({ page }) => {
  await unfocus(page);
  const before = await canvas(page).getAttribute('viewBox');
  await page.keyboard.press('f');
  await expect(canvas(page)).not.toHaveAttribute('viewBox', before!);
  const fitted = await canvas(page).getAttribute('viewBox');
  await page.keyboard.press('0');
  await page.getByRole('button', { name: 'Fit circuit', exact: true }).click();
  await expect(canvas(page)).toHaveAttribute('viewBox', fitted!);
  await page.keyboard.press('?');
  const help = page.getByRole('dialog', { name: 'Keyboard shortcuts', exact: true });
  await expect(help).toBeVisible();
  await expect(help).toContainText('Space');
  await expect(help).toContainText('Ctrl/Cmd+Z');
  await page.keyboard.press('Escape');
  await expect(help).not.toBeVisible();
});

for (const field of ['input', 'textarea', 'JSON editor']) {
  test(`shortcuts do not fire while typing in ${field}`, async ({ page }) => {
    await place(page);
    await page.locator('[data-comp-id="or1"]').click();
    await page.getByRole('button', { name: 'Pause', exact: true }).click();
    await expect(metrics(page)).toContainText('Paused');
    const beforeMetrics = await metrics(page).textContent();
    const beforeView = await canvas(page).getAttribute('viewBox');
    const beforeTransform = await page.locator('[data-comp-id="or1"]').getAttribute('transform');
    let target = page.locator('.inspector-form input[data-field="label"]');
    if (field === 'textarea') target = page.locator('.inspector-form textarea[data-field="params"]');
    if (field === 'JSON editor') {
      await page.getByRole('button', { name: 'Paste JSON', exact: true }).click();
      target = page.getByRole('textbox', { name: 'Paste circuit JSON', exact: true });
    }
    await target.fill('typing');
    await target.focus();
    for (const key of ['Space', '.', 'Control+KeyZ', 'Control+Shift+KeyZ', 'Meta+KeyZ', 'Meta+Shift+KeyZ', 'Control+KeyY', 'Delete', 'Backspace', 'r', 'f', '?']) {
      await target.press(key);
    }
    // Flush the UI turn; none of these keys may enqueue editor/worker actions.
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => resolve())));
    await expect(page.locator('[data-comp-id="or1"]')).toHaveAttribute('transform', beforeTransform!);
    await expect(canvas(page)).toHaveAttribute('viewBox', beforeView!);
    await expect(metrics(page)).toHaveText(beforeMetrics!);
    await expect(page.getByRole('dialog', { name: 'Keyboard shortcuts', exact: true })).not.toBeVisible();
    if (field === 'JSON editor') await page.getByRole('button', { name: 'Cancel paste', exact: true }).click();
    // Escape is also ignored in a focused ordinary text field.
    await page.locator('.palette-entry[data-palette-type="prim.OR"]').click();
    const input = page.getByLabel('Simulation ticks per second', { exact: true });
    await input.focus(); await input.press('Escape');
    await expect(page.locator('.palette-entry[data-palette-type="prim.OR"]')).toHaveAttribute('aria-pressed', 'true');
    await unfocus(page); await page.keyboard.press('Escape');
    await expect(page.locator('.palette-entry[data-palette-type="prim.OR"]')).toHaveAttribute('aria-pressed', 'false');
  });
}


test('Escape closes bus mapping and cancels bus mode', async ({ page }) => {
  const circuit = { version: 1, kind: 'circuit', name: 'bus cancellation',
    components: [
      { id: 'rom', type: 'mem.ROM', params: { addressBits: 2, dataBits: 2 }, position: [100, 100] },
      { id: 'mux', type: 'prim.MUX2', params: { width: 2 }, position: [320, 100] },
    ], nets: [],
  };
  await page.locator('input[data-file-action="load-input"]').setInputFiles({
    name: 'bus.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(circuit)),
  });
  await expect(page.locator('[data-comp-id="rom"]')).toBeVisible();
  const bus = page.getByRole('button', { name: 'Connect bus', exact: true });
  await bus.click();
  await page.locator('[data-pin="rom.D0"]').click(); await page.locator('[data-pin="mux.A0"]').click();
  const dialog = page.getByRole('dialog', { name: 'Connect bus', exact: true });
  await expect(dialog).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(dialog).not.toBeVisible(); await expect(bus).toHaveAttribute('aria-pressed', 'false');
});
