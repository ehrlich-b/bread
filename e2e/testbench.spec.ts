import { expect, test, type Page } from '@playwright/test';
import fullAdder from '../examples/full_adder.json';
import fullBench from '../examples/testbenches/full_adder.json';
import sapBench from '../examples/testbenches/sap1_fibonacci.json';

const button = (page: Page, name: string) => page.getByRole('button', { name, exact: true });
const status = (page: Page) => page.getByLabel('Testbench result', { exact: true });

async function openAdder(page: Page): Promise<void> {
  await page.goto('/');
  await button(page, 'Pause').click();
  await page.locator('[data-file-action="examples"]').selectOption('full_adder');
  await expect(page.locator('[data-pin="xor2.Y"]')).toBeVisible();
}

test('pasted exhaustive testbench runs against the open adder and shows every vector', async ({ page }) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await openAdder(page);
  await page.getByLabel('Testbench JSON', { exact: true }).fill(JSON.stringify(fullBench));
  await button(page, 'Run testbench').click();
  await expect(status(page)).toHaveText('PASS Full adder exhaustive: 8/8 vectors');
  await expect(page.getByLabel('Testbench vectors', { exact: true }).locator('li[data-passed="true"]')).toHaveCount(8);
  await expect(page.getByLabel('Simulation throughput', { exact: true })).toContainText('Paused');
  // A repeat starts at power-on state and leaves the visible switches alone.
  await button(page, 'Run testbench').click();
  await expect(status(page)).toHaveText('PASS Full adder exhaustive: 8/8 vectors');
  await expect(page.locator('[data-comp-id="a"] [data-role="switch-label"]')).toHaveText('0');
  expect(errors).toEqual([]);
});

test('loaded bench identifies a broken vector and focuses its captured waveform', async ({ page }) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await openAdder(page);
  const broken = structuredClone(fullAdder);
  broken.components.find(component => component.id === 'xor1')!.type = 'prim.OR';
  const probed = { ...broken, name: 'Broken adder', probes: [{ id: 'sum', label: 'Sum', nets: ['sum_out'] }] };
  await page.locator('input[data-file-action="load-input"]').setInputFiles({ name: 'broken-adder.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(probed)) });
  await expect(page.getByLabel('Waveform Sum', { exact: true })).toBeVisible();
  await page.getByLabel('Load testbench', { exact: true }).setInputFiles({ name: 'adder-testbench.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(fullBench)) });
  await expect(status(page)).toHaveText('Loaded Full adder exhaustive');
  await button(page, 'Run testbench').click();
  await expect(status(page)).toHaveText('FAIL Full adder exhaustive: 6/8 vectors · 2 failed');
  const failures = page.getByLabel('Testbench vectors', { exact: true }).locator('li[data-passed="false"]');
  await expect(failures).toHaveCount(2);
  await expect(failures.first()).toContainText('FAIL 4:');
  await expect(failures.first()).toContainText('Sum: expected 0, actual 1');
  await button(page, 'Show failing vector 4').click();
  await expect(page.getByLabel('Waveform cursor tick', { exact: true })).toHaveValue('4');
  await expect(page.getByLabel('Cursor Sum', { exact: true })).toHaveText('1 (1)');
  await button(page, 'Show failing vector 8').click();
  await expect(page.getByLabel('Waveform cursor tick', { exact: true })).toHaveValue('8');
  await expect(page.getByLabel('Cursor Sum', { exact: true })).toHaveText('0 (0)');
  expect(errors).toEqual([]);
});

test('schema errors are visible and circuit edits clear obsolete results', async ({ page }) => {
  await openAdder(page);
  const text = page.getByLabel('Testbench JSON', { exact: true });
  await text.fill(JSON.stringify({ ...fullBench, version: 2 }));
  await button(page, 'Run testbench').click();
  await expect(page.getByLabel('Testbench panel', { exact: true }).getByRole('alert')).toContainText('expected 1');
  await text.fill(JSON.stringify(fullBench));
  await button(page, 'Run testbench').click();
  await expect(status(page)).toContainText('PASS');
  await page.locator('[data-file-action="examples"]').selectOption('blink_demo');
  await expect(page.locator('[data-pin="clk.Y"]')).toBeVisible();
  await expect(status(page)).toHaveText('');
  await expect(page.getByLabel('Testbench vectors', { exact: true }).locator('li')).toHaveCount(0);
});

test('SAP-1 corpus checks three ordered Fibonacci cycles in the worker', async ({ page }) => {
  test.setTimeout(30_000);
  await page.goto('/'); await button(page, 'Pause').click();
  await page.locator('[data-file-action="examples"]').selectOption('ben_eater_8bit');
  await expect(page.locator('[data-comp-id="display"]')).toBeVisible();
  await page.getByLabel('Testbench JSON', { exact: true }).fill(JSON.stringify(sapBench));
  await button(page, 'Run testbench').click();
  await expect(status(page)).toHaveText('PASS SAP-1 Fibonacci OUT sequence: 41/41 vectors', { timeout: 20_000 });
  await expect(page.getByLabel('Testbench vectors', { exact: true }).locator('li[data-passed="true"]')).toHaveCount(41);
});
