// Ordinary imported-fixture regression; this is not manual construction.
import { expect, test } from '@playwright/test';
import originalCpu from '../examples/original_digital_cpu_generated.json';

test('original CALLRET program boots, outputs 1 through 10 and halts in the browser', async ({ page }) => {
  test.setTimeout(60_000);
  const errors: string[] = []; page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/');
  await page.getByRole('button', { name: 'Pause', exact: true }).click();
  await page.locator('[data-file-action="examples"]').selectOption('original_digital_cpu_generated');
  await expect(page.locator('[data-comp-id]')).toHaveCount(70);
  await page.getByRole('button', { name: 'Fit circuit', exact: true }).click();
  await page.locator('[data-comp-id="v34"] .gate-body').click();
  const output = page.getByLabel('Live Q[7:0]', { exact: true });
  const expectedOutput = Array.from({ length: 11 }, (_, value) =>
    `${value.toString(16).toUpperCase().padStart(2, '0')}\n${value.toString(2).padStart(8, '0')}`);
  await expect(output).toHaveText(expectedOutput[0]!);
  const outputHistory = await output.evaluateHandle((element) => {
    const values = [element.textContent ?? ''];
    const record = (mutations: MutationRecord[]): void => {
      for (const mutation of mutations) {
        // The inspector replaces textContent. Read each replacement node so
        // even several changes in one observer delivery retain their order.
        const value = Array.from(mutation.addedNodes, (node) => node.textContent ?? '').join('');
        if (value !== values.at(-1)) values.push(value);
      }
    };
    const observer = new MutationObserver(record);
    observer.observe(element, { childList: true });
    return { values, observer, record };
  });
  await page.getByRole('button', { name: 'Run', exact: true }).click();
  // Keep the output inspector selected until Hlt goes high on the schematic.
  const haltNet = originalCpu.nets.find((net) => net.endpoints.includes('v68.Hlt'))!.id;
  await expect(page.locator(`polyline.wire[data-net-id="${haltNet}"]`)).toHaveClass('wire wire-1', { timeout: 45_000 });
  await expect(output).toHaveText(expectedOutput.at(-1)!);
  await page.locator('[data-comp-id="v68"] .gate-body').click();
  await expect(page.getByLabel('Live Hlt', { exact: true })).toHaveText('1');
  const values = await outputHistory.evaluate(({ values, observer, record }) => {
    record(observer.takeRecords());
    observer.disconnect();
    return values;
  });
  await outputHistory.dispose();
  expect(values).toEqual(expectedOutput);
  expect(errors).toEqual([]);
});

test('the labeled original CPU port fits, exposes signals and cold-reopens its full hierarchy', async ({ page }) => {
  const errors: string[] = []; page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/'); await page.getByRole('button', { name: 'Pause', exact: true }).click();
  await page.locator('[data-file-action="examples"]').selectOption('original_digital_cpu_generated');
  await expect(page.locator('[data-comp-id]')).toHaveCount(70);
  await page.getByRole('button', { name: 'Fit circuit', exact: true }).click();
  const view = (await page.locator('svg[data-role="canvas"]').getAttribute('viewBox'))!.split(' ').map(Number);
  expect(view[3]).toBeGreaterThan(2200);
  await page.locator('[data-comp-id="v0"] .gate-body').click();
  await expect(page.getByLabel('Live Q[7:0]', { exact: true })).toContainText('00000000');
  await page.getByRole('textbox', { name: 'Label', exact: true }).fill('Accumulator A');
  await page.getByRole('button', { name: 'Apply', exact: true }).click();
  await page.getByRole('button', { name: 'Circuit JSON', exact: true }).click();
  const text = await page.getByRole('textbox', { name: 'Circuit JSON', exact: true }).inputValue();
  const saved = JSON.parse(text) as { name: string; components: Array<{ id: string; label?: string }>; definitions: unknown[] };
  expect(saved.name).toContain('GENERATED'); expect(saved.definitions).toHaveLength(25);
  expect(saved.components.find((c) => c.id === 'v0')?.label).toBe('Accumulator A');
  await page.getByRole('button', { name: 'Close JSON', exact: true }).click();
  await expect(page.locator('[data-comp-id="v0"]')).toContainText('Accumulator A');
  await page.reload(); await page.getByRole('button', { name: 'Pause', exact: true }).click();
  await page.locator('input[data-file-action="load-input"]').setInputFiles({
    name: 'original-port.json', mimeType: 'application/json', buffer: Buffer.from(text),
  });
  await expect(page.locator('[data-comp-id]')).toHaveCount(70);
  await expect(page.locator('[data-comp-id="v0"]')).toContainText('Accumulator A');
  await expect(page.getByRole('button', { name: 'Edit Digital_control_logic', exact: true })).toBeVisible();
  expect(errors).toEqual([]);
});
