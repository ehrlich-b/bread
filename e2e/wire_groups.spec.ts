import { expect, test, type Page } from './fixtures';
import sap1 from '../examples/ben_eater_8bit.json' with { type: 'json' };

const button = (page: Page, name: string) => page.getByRole('button', { name, exact: true });
const bundle = (page: Page) => page.locator('[data-role="wire-bundle"]');
const fixture = {
  version: 1, kind: 'circuit', name: 'grouped byte',
  components: [
    { id: 'rom', type: 'mem.ROM', params: { addressBits: 2, dataBits: 8, contents: '2A' }, position: [80, 60] },
    { id: 'target', type: 'prim.MUX2', params: { width: 8 }, position: [380, 60] },
    { id: 'gnd', type: 'prim.CONST_0', position: [20, 240] },
    { id: 'enable', type: 'io.switch', position: [80, 270] },
    { id: 'led', type: 'io.led', position: [250, 320] },
  ],
  nets: [
    ...Array.from({ length: 8 }, (_, bit) => ({ id: `bit${bit}`, endpoints: [`rom.D${bit}`, `target.A${bit}`] })),
    { id: 'address', endpoints: ['gnd.Y', 'rom.A0', 'rom.A1'] },
    { id: 'enable', endpoints: ['enable.Y', 'rom.SEL'] },
  ],
};

async function open(page: Page, circuit: unknown): Promise<void> {
  await page.goto('/'); await button(page, 'Pause').click();
  await page.locator('input[data-file-action="load-input"]').setInputFiles({
    name: 'grouped-wires.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(circuit)),
  });
  await expect(page.locator('[data-comp-id]')).toHaveCount((circuit as typeof fixture).components.length);
  await button(page, 'Fit circuit').click();
}

async function exported(page: Page) {
  await button(page, 'Circuit JSON').click();
  const text = await page.getByRole('textbox', { name: 'Circuit JSON', exact: true }).inputValue();
  await button(page, 'Close JSON').click(); return JSON.parse(text);
}

// Click the short, separate stub next to the source pin, away from both the
// pin circle and the shared trunk. This exercises real SVG hit testing.
async function clickBit(page: Page, net: string): Promise<void> {
  const point = await page.locator(`[data-role="wire-bit"][data-net-id="${net}"]`).evaluate(el => {
    const path = el as SVGPathElement;
    const local = path.getPointAtLength(8);
    const ctm = path.getScreenCTM(); if (!ctm) throw new Error('Wire transform unavailable');
    return { x: ctm.a * local.x + ctm.c * local.y + ctm.e, y: ctm.b * local.x + ctm.d * local.y + ctm.f };
  });
  await page.mouse.click(point.x, point.y);
}

test('SAP-1 grouping toggle retains JSON and selection and restores individual wires', async ({ page }) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await open(page, sap1);
  await expect(page.locator('[data-wire-group]')).toHaveCount(5);
  await expect(bundle(page).filter({ has: page.locator('title') })).toHaveCount(12);
  await expect(page.locator('[data-role="wire-bundle"][data-width="8"]')).toHaveCount(8);
  await expect(page.locator('[data-role="wire-bundle"][data-width="4"]')).toHaveCount(4);
  await page.locator('[data-comp-id="reg_a"] .gate-body').click();
  const before = await exported(page);
  // Opening the file is the newest undo entry; grouping must not add another.
  await expect(button(page, 'Undo')).toBeEnabled();
  await button(page, 'Group wires').click();
  await expect(button(page, 'Group wires')).toHaveAttribute('aria-pressed', 'false');
  await expect(bundle(page)).toHaveCount(0);
  await expect(page.locator('polyline.wire')).toHaveCount(135);
  await expect(page.locator('[data-comp-id="reg_a"]')).toHaveAttribute('data-selected', 'true');
  expect(await exported(page)).toEqual(before);
  await button(page, 'Group wires').click();
  await expect(button(page, 'Group wires')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('[data-wire-group]')).toHaveCount(5);
  await button(page, 'Undo').click();
  await expect(page.locator('[data-comp-id="reg_a"]')).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('grouped byte shows live hex, Z and X while a fan-out probe captures only the chosen bit', async ({ page }) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await open(page, fixture);
  const label = page.locator('[data-role="wire-bundle-label"]');
  await expect(bundle(page)).toHaveCount(1);
  await expect(label).toHaveText('/8 ZZ');
  await expect(bundle(page)).toHaveClass('wire wire-bus wire-Z');
  await page.locator('[data-comp-id="enable"] .switch-handle').click();
  await expect(label).toHaveText('/8 0x2A');
  await expect(bundle(page)).toHaveAttribute('data-binary', '00101010');
  await button(page, 'Probe net').click(); await clickBit(page, 'bit3');
  await expect(button(page, 'Probe net')).toHaveAttribute('aria-pressed', 'false');
  await expect(page.getByLabel('Waveform bit3', { exact: true })).toBeVisible();
  await expect(page.locator('[data-role="wire-bit"][data-net-id="bit3"]')).toHaveAttribute('data-probed', 'true');
  const saved = await exported(page);
  expect(saved.probes).toEqual([{ id: 'probe1', label: 'bit3', nets: ['bit3'] }]);
  expect(saved.nets).toEqual(fixture.nets);
  await button(page, 'Undo').click(); await expect(page.getByLabel('Waveform bit3', { exact: true })).toHaveCount(0);
  await button(page, 'Redo').click(); await expect(page.getByLabel('Waveform bit3', { exact: true })).toBeVisible();
  await page.locator('[data-comp-id="gnd"] .gate-body').click();
  await button(page, 'Delete').click();
  await expect(page.locator('[data-comp-id="gnd"]')).toHaveCount(0);
  await page.locator('[data-comp-id="enable"] .switch-handle').click();
  await expect(label).toHaveText('/8 XX'); await expect(bundle(page)).toHaveClass('wire wire-bus wire-X');
  expect(errors).toEqual([]);
});

test('editing a grouped bit preserves its other connections through undo, redo and save/reopen', async ({ page }) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await open(page, fixture);
  const group = await page.locator('[data-wire-group]').getAttribute('data-wire-group');
  await page.locator('[data-pin="target.A3"]').click();
  // A visual toggle must not discard a wire being drawn.
  await button(page, 'Group wires').click(); await button(page, 'Group wires').click();
  await expect(page.locator('[data-pin="target.A3"]')).toHaveClass(/pin-active/);
  await page.locator('[data-pin="led.A"]').click();
  await expect.poll(async () => (await exported(page)).nets.find((net: { id: string }) => net.id === 'bit3').endpoints)
    .toEqual(['rom.D3', 'target.A3', 'led.A']);
  await expect(page.locator('[data-wire-group]')).toHaveAttribute('data-wire-group', group!);
  const saved = await exported(page);
  await button(page, 'Undo').click();
  await expect.poll(async () => (await exported(page)).nets).toEqual(fixture.nets);
  await button(page, 'Redo').click();
  await expect.poll(async () => (await exported(page)).nets).toEqual(saved.nets);
  await open(page, saved);
  expect((await exported(page)).nets).toEqual(saved.nets);
  await expect(page.locator('[data-wire-group]')).toHaveAttribute('data-wire-group', group!);
  await page.locator('[data-comp-id="enable"] .switch-handle').click();
  await expect(page.locator('[data-role="led"]')).toHaveAttribute('fill', 'var(--led-on)');
  expect(errors).toEqual([]);
});

test('Connect bus produces a visual bundle and one atomic undo without changing the saved format', async ({ page }) => {
  await open(page, { ...fixture, nets: fixture.nets.filter(net => !net.id.startsWith('bit')) });
  await button(page, 'Connect bus').click();
  await page.locator('[data-pin="rom.D0"]').click(); await page.locator('[data-pin="target.A0"]').click();
  const dialog = page.getByRole('dialog', { name: 'Connect bus', exact: true });
  await expect(dialog.getByLabel('Bus width')).toHaveValue('8');
  await dialog.getByRole('button', { name: 'Connect these bits', exact: true }).click();
  await expect(bundle(page)).toHaveCount(1); await expect(bundle(page)).toHaveAttribute('data-width', '8');
  const saved = await exported(page);
  expect(saved.nets.filter((net: { endpoints: string[] }) => net.endpoints.some(ep => ep.startsWith('rom.D')))).toHaveLength(8);
  await button(page, 'Undo').click(); await expect(bundle(page)).toHaveCount(0);
  await button(page, 'Redo').click(); await expect(bundle(page)).toHaveCount(1);
  expect(await exported(page)).toEqual(saved);
});
