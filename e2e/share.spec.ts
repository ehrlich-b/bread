import { expect, test, type Page } from '@playwright/test';
import type { CircuitJSON } from '../src/engine/ir';
import { encodeCircuit } from '../src/ui/permalink';

const project: CircuitJSON = {
  version: 1, kind: 'circuit', name: 'shared bread 🍞',
  components: [{ id: 'chip', type: 'user.Buffer', label: 'µ buffer', position: [140, 100], rotation: 90 }],
  nets: [{ id: 'out', endpoints: ['chip.Y'] }],
  probes: [{ id: 'p', label: 'output', nets: ['out'] }],
  definitions: [{ version: 1, kind: 'composite', name: 'user.Buffer',
    components: [{ id: 'buf', type: 'prim.BUF' }],
    nets: [{ id: 'in', endpoints: ['buf.A'] }, { id: 'out', endpoints: ['buf.Y'] }],
    ports: [{ name: 'A', dir: 'in', internalNet: 'in' }, { name: 'Y', dir: 'out', internalNet: 'out' }],
  }],
};
const exported = async (page: Page): Promise<unknown> => {
  await page.getByRole('button', { name: 'Circuit JSON', exact: true }).click();
  const text = await page.getByRole('textbox', { name: 'Circuit JSON', exact: true }).inputValue();
  await page.getByRole('button', { name: 'Close JSON', exact: true }).click();
  return JSON.parse(text) as unknown;
};
const openProject = async (page: Page): Promise<void> => {
  await page.locator('input[data-file-action="load-input"]').setInputFiles({
    name: 'share.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(project)),
  });
  await expect(page.locator('[data-comp-id="chip"]')).toBeVisible();
};

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('svg[data-role="canvas"]')).toBeVisible();
});

test('Share then reload restores an identical circuit export, probes and chip library', async ({ page }) => {
  await openProject(page);
  const before = await exported(page);
  expect(before).toEqual(project);
  await page.getByRole('button', { name: 'Share', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Share circuit', exact: true });
  await expect(dialog).toBeVisible();
  const url = await dialog.getByRole('textbox', { name: 'Share link', exact: true }).inputValue();
  expect(url).toBe(page.url());
  expect(new URL(url).hash).toMatch(/^#c1=/);
  expect(url.length).toBeLessThanOrEqual(16_000);
  await page.reload();
  await expect(page.locator('[data-comp-id="chip"]')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Remove probe output', exact: true })).toBeVisible();
  expect(await exported(page)).toEqual(before);
});

test('hashchange loads through editor history and named examples open on page load', async ({ page }) => {
  await page.goto('/#example=full_adder');
  await expect(page.locator('[data-comp-id]')).toHaveCount(10);
  const before = await exported(page);
  const hash = await encodeCircuit(project);
  await page.evaluate(hash => { location.hash = hash; }, hash);
  await expect(page.locator('[data-comp-id="chip"]')).toBeVisible();
  expect(await exported(page)).toEqual(project);
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(page.locator('[data-comp-id]')).toHaveCount(10);
  expect(await exported(page)).toEqual(before);
});

for (const hash of ['#c1=corrupt.truncated', '#c2=future']) {
  test(`${hash} shows an error and leaves the current circuit intact`, async ({ page }) => {
    await openProject(page);
    const before = await exported(page);
    await page.evaluate(hash => { location.hash = hash; }, hash);
    await expect(page.getByRole('alert').filter({ hasText: 'Cannot open shared circuit' })).toContainText(
      hash.startsWith('#c2') ? 'Unsupported shared circuit link version' : 'corrupt or truncated',
    );
    expect(await exported(page)).toEqual(before);
    // A failed link adds no history entry: Undo reverts the successful file load.
    await page.getByRole('button', { name: 'Undo', exact: true }).click();
    await expect(page.locator('[data-comp-id="and"]')).toBeVisible();
    await expect(page.locator('[data-comp-id="chip"]')).toHaveCount(0);
  });
}

test('a corrupt link on page open leaves the default circuit intact', async ({ page }) => {
  await page.goto('/#c1=broken');
  await expect(page.getByRole('alert').filter({ hasText: 'Cannot open shared circuit' })).toContainText('corrupt or truncated');
  await expect(page.locator('[data-comp-id]')).toHaveCount(4);
  await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeDisabled();
});

test('a correctly encoded invalid circuit still goes through Open JSON validation', async ({ page }) => {
  await openProject(page);
  const before = await exported(page);
  const hash = await encodeCircuit({ ...project, components: [{ id: 'bad', type: 'unknown.executable' }] });
  await page.evaluate(hash => { location.hash = hash; }, hash);
  await expect(page.getByRole('alert').filter({ hasText: 'Cannot open shared circuit' })).toBeVisible();
  expect(await exported(page)).toEqual(before);
});

test('Share refuses impractical URLs and preserves the address and circuit', async ({ page }) => {
  await page.locator('select[data-file-action="examples"]').selectOption('original_digital_cpu_generated');
  await expect(page.locator('[data-comp-id="and"]')).toHaveCount(0);
  const before = await exported(page);
  const address = page.url();
  await page.getByRole('button', { name: 'Share', exact: true }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'Circuit is too large to share' })).toContainText('limit 16,000');
  await expect(page.getByRole('dialog', { name: 'Share circuit', exact: true })).not.toBeVisible();
  expect(page.url()).toBe(address);
  expect(await exported(page)).toEqual(before);
});


test('shared circuit IDs render as data and never execute markup', async ({ page }) => {
  const id = '<img src=x onerror="__breadShareExecuted=1">';
  const circuit: CircuitJSON = { version: 1, kind: 'circuit', name: 'literal IDs',
    components: [{ id, type: 'prim.BUF', position: [140, 100] }, { id: 'other', type: 'prim.BUF', position: [280, 100] }], nets: [],
  };
  const hash = await encodeCircuit(circuit);
  await page.evaluate(hash => {
    (window as Window & { __breadShareExecuted?: number }).__breadShareExecuted = 0;
    location.hash = hash;
  }, hash);
  const components = page.locator('[data-comp-type="prim.BUF"]');
  await expect(components).toHaveCount(2);
  await components.nth(0).locator('.gate-body').click();
  await components.nth(1).locator('.gate-body').click({ modifiers: ['Shift'] });
  await expect(page.locator('#inspector')).toContainText(id);
  await expect(page.locator('#inspector img')).toHaveCount(0);
  expect(await page.evaluate(() => (window as Window & { __breadShareExecuted?: number }).__breadShareExecuted)).toBe(0);
});
