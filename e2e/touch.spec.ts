import { expect, test, type CDPSession, type Locator, type Page } from '@playwright/test';
import type { CircuitJSON } from '../src/engine/ir';

test.use({ hasTouch: true, isMobile: true, viewport: { width: 390, height: 844 } });

const canvas = (page: Page) => page.locator('svg[data-role="canvas"]');
const button = (page: Page, name: string) => page.getByRole('button', { name, exact: true });
type Point = { x: number; y: number };
type Finger = Point & { id: number };

async function openPanel(page: Page, panel: string): Promise<void> {
  const details = page.locator(`.panel-${panel}`);
  if (await details.getAttribute('open') === null) await details.locator(':scope > summary').tap();
  await expect(details).toHaveAttribute('open', '');
}

async function localPoint(page: Page, x: number, y: number): Promise<Point> {
  await canvas(page).scrollIntoViewIfNeeded();
  return canvas(page).evaluate((svg, point) => {
    const ctm = (svg as SVGSVGElement).getScreenCTM();
    if (!ctm) throw new Error('Canvas transform unavailable');
    const client = new DOMPoint(point.x, point.y).matrixTransform(ctm);
    return { x: client.x, y: client.y };
  }, { x, y });
}

async function center(locator: Locator): Promise<Point> {
  await locator.scrollIntoViewIfNeeded();
  const box = await locator.boundingBox();
  if (!box) throw new Error('Touch target unavailable');
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

async function touch(session: CDPSession, type: 'touchStart' | 'touchMove' | 'touchEnd' | 'touchCancel', fingers: Finger[]): Promise<void> {
  await session.send('Input.dispatchTouchEvent', { type, touchPoints: fingers.map(finger => ({ ...finger, radiusX: 8, radiusY: 8 })) });
}

async function drag(page: Page, target: Locator, dx: number, dy: number): Promise<void> {
  const session = await page.context().newCDPSession(page);
  try {
    const from = await center(target);
    await touch(session, 'touchStart', [{ ...from, id: 1 }]);
    for (let step = 1; step <= 6; step++) {
      await touch(session, 'touchMove', [{ x: from.x + dx * step / 6, y: from.y + dy * step / 6, id: 1 }]);
    }
    await touch(session, 'touchEnd', []);
  } finally { await session.detach(); }
}

async function hold(page: Page, point: Point): Promise<void> {
  const session = await page.context().newCDPSession(page);
  try {
    await touch(session, 'touchStart', [{ ...point, id: 1 }]);
    await expect(page.getByRole('dialog', { name: 'Canvas actions', exact: true })).toBeVisible();
    await touch(session, 'touchEnd', []);
  } finally { await session.detach(); }
}

async function place(page: Page, type: string, id: string, x: number, y: number): Promise<void> {
  await openPanel(page, 'palette');
  await page.locator(`[data-palette-type="${type}"]`).tap();
  await expect(page.locator('.panel-palette')).not.toHaveAttribute('open', '');
  const point = await localPoint(page, x, y);
  await page.touchscreen.tap(point.x, point.y);
  await expect(page.locator(`[data-comp-id="${id}"]`)).toBeVisible();
}

async function exportCircuit(page: Page): Promise<CircuitJSON> {
  await openPanel(page, 'file'); await button(page, 'Circuit JSON').tap();
  const text = await page.getByRole('textbox', { name: 'Circuit JSON', exact: true }).inputValue();
  await button(page, 'Close JSON').tap(); return JSON.parse(text) as CircuitJSON;
}

async function emptyCircuit(page: Page): Promise<void> {
  await openPanel(page, 'file'); await button(page, 'New circuit').tap();
  await expect(page.locator('[data-comp-id]')).toHaveCount(0);
}

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await expect(page.getByLabel('Simulation throughput', { exact: true })).toContainText('Running');
  await button(page, 'Pause').tap();
  await expect(page.getByLabel('Simulation throughput', { exact: true })).toContainText('Paused');
});

test('touch places, selects, moves, wires, probes and runs a small circuit', async ({ page }) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  expect(await page.evaluate(() => navigator.maxTouchPoints)).toBeGreaterThan(0);
  await emptyCircuit(page);
  await place(page, 'io.switch', 'switch1', 115, 140);
  await place(page, 'prim.BUF', 'buf1', 290, 140);
  await place(page, 'io.led', 'led1', 460, 140);

  const buffer = page.locator('[data-comp-id="buf1"]');
  await buffer.locator('.gate-body').tap();
  await expect(buffer).toHaveAttribute('data-selected', 'true');
  await expect(page.locator('.panel-inspector')).toHaveAttribute('open', '');
  const original = await buffer.getAttribute('transform');
  await drag(page, buffer.locator('.gate-body'), 30, 35);
  await expect(buffer).not.toHaveAttribute('transform', original!);
  const moved = await buffer.getAttribute('transform');
  const position = /^translate\((-?\d+) (-?\d+)\)$/.exec(moved!)!;
  expect(Number(position[1]) % 10).toBe(0); expect(Number(position[2]) % 10).toBe(0);
  await button(page, 'Undo').tap(); await expect(buffer).toHaveAttribute('transform', original!);
  await button(page, 'Redo').tap(); await expect(buffer).toHaveAttribute('transform', moved!);

  await page.locator('[data-pin="switch1.Y"]').tap();
  await expect(page.locator('[data-pin="switch1.Y"]')).toHaveClass(/pin-active/);
  await page.locator('[data-pin="buf1.A"]').tap();
  await expect(page.locator('polyline.wire[data-net-id]')).toHaveCount(1);
  await page.locator('[data-pin="buf1.Y"]').tap(); await page.locator('[data-pin="led1.A"]').tap();
  await expect(page.locator('polyline.wire[data-net-id]')).toHaveCount(2);

  await hold(page, await center(page.locator('[data-pin="buf1.Y"]')));
  await page.getByRole('dialog', { name: 'Canvas actions' }).getByRole('button', { name: 'Probe pin', exact: true }).tap();
  await expect(page.locator('[data-pin="buf1.Y"]')).toHaveAttribute('data-probed', 'true');
  await expect(page.getByLabel('Waveform buf1.Y', { exact: true })).toBeVisible();
  await page.locator('[data-comp-id="switch1"] .switch-handle').tap();
  // A compatibility click must not toggle the switch back off.
  await expect(page.locator('[data-comp-id="switch1"] [data-role="switch-label"]')).toHaveText('1');
  await button(page, 'Run').tap();
  await expect(page.getByLabel('Simulation throughput', { exact: true })).toContainText('Running');
  await expect(page.locator('[data-comp-id="led1"] [data-role="led"]')).toHaveAttribute('fill', 'var(--led-on)');
  await button(page, 'Pause').tap();
  await expect(page.getByLabel('Waveform capture', { exact: true })).toContainText('Paused');
  await expect(page.getByLabel('Waveform buf1.Y', { exact: true }).locator('[data-value="1"]')).toHaveCount(1);
  const throughput = page.getByLabel('Simulation throughput', { exact: true });
  const before = await throughput.textContent();
  const ticks = Number(/· ([\d,]+) ticks$/.exec(before!)![1]!.replace(/,/g, ''));
  await button(page, 'Step').tap(); await expect(throughput).toContainText(`· ${(ticks + 1).toLocaleString('en-US')} ticks`);
  const saved = await exportCircuit(page);
  expect(saved.components).toHaveLength(3);
  expect(saved.nets.map(net => net.endpoints)).toEqual([['switch1.Y', 'buf1.A'], ['buf1.Y', 'led1.A']]);
  expect(saved.probes).toEqual([{ id: 'probe1', label: 'buf1.Y', nets: ['n2'] }]);
  expect(errors).toEqual([]);
});

test('touch pans and pinches without moving components, clearing selection or adding undo entries', async ({ page }) => {
  await emptyCircuit(page); await place(page, 'prim.BUF', 'buf1', 290, 140);
  const buffer = page.locator('[data-comp-id="buf1"]'); await buffer.locator('.gate-body').tap();
  const original = await buffer.getAttribute('transform');
  const startView = await canvas(page).getAttribute('viewBox');
  const session = await page.context().newCDPSession(page);
  try {
    const from = await localPoint(page, 80, 260);
    const pageY = await page.evaluate(() => window.scrollY);
    await touch(session, 'touchStart', [{ ...from, id: 1 }]);
    await touch(session, 'touchMove', [{ x: from.x + 20, y: from.y + 25, id: 1 }]);
    await touch(session, 'touchEnd', []);
    await expect(canvas(page)).not.toHaveAttribute('viewBox', startView!);
    expect(await page.evaluate(() => window.scrollY)).toBe(pageY);
    await expect(buffer).toHaveAttribute('data-selected', 'true');
    await expect(buffer).toHaveAttribute('transform', original!);

    // Begin on the component and preview a move before introducing a second
    // finger. Pinching must restore the preview and consume both releases.
    const first = await center(buffer.locator('.gate-body'));
    const second = await localPoint(page, 470, 180);
    const panned = (await canvas(page).getAttribute('viewBox'))!.split(' ').map(Number);
    await touch(session, 'touchStart', [{ ...first, id: 1 }]);
    const shifted = { x: first.x + 15, y: first.y + 10, id: 1 };
    await touch(session, 'touchMove', [shifted]);
    await expect(buffer).not.toHaveAttribute('transform', original!);
    await touch(session, 'touchStart', [shifted, { ...second, id: 2 }]);
    await expect(buffer).toHaveAttribute('transform', original!);
    await touch(session, 'touchMove', [{ x: shifted.x - 20, y: shifted.y, id: 1 }, { x: second.x + 20, y: second.y, id: 2 }]);
    await touch(session, 'touchEnd', []);
    const zoomed = (await canvas(page).getAttribute('viewBox'))!.split(' ').map(Number);
    expect(zoomed[2]!).toBeLessThan(panned[2]!);
    await expect(buffer).toHaveAttribute('transform', original!);
    await expect(buffer).toHaveAttribute('data-selected', 'true');
    await expect(page.getByRole('dialog', { name: 'Canvas actions' })).toHaveCount(0);
  } finally { await session.detach(); }
  // Undo still removes the placement: neither gesture creates a history item.
  await button(page, 'Undo').tap(); await expect(buffer).toHaveCount(0);
});

test('long press exposes select, rotate, delete and cancellation without a stray tap', async ({ page }) => {
  await emptyCircuit(page); await place(page, 'prim.BUF', 'buf1', 290, 140);
  const buffer = page.locator('[data-comp-id="buf1"]');
  const menu = page.getByRole('dialog', { name: 'Canvas actions', exact: true });
  await hold(page, await center(buffer.locator('.gate-body')));
  await expect(buffer).not.toHaveAttribute('data-selected', 'true');
  await menu.getByRole('button', { name: 'Rotate', exact: true }).tap();
  await expect(buffer).toHaveAttribute('transform', /rotate\(90/);
  await button(page, 'Undo').tap(); await expect(buffer).toHaveAttribute('transform', 'translate(270 120)');
  await button(page, 'Redo').tap(); await expect(buffer).toHaveAttribute('transform', /rotate\(90/);
  await hold(page, await center(buffer.locator('.gate-body')));
  await menu.getByRole('button', { name: 'Select', exact: true }).tap();
  await expect(buffer).toHaveAttribute('data-selected', 'true');
  await hold(page, await center(buffer.locator('.gate-body')));
  await menu.getByRole('button', { name: 'Delete', exact: true }).tap(); await expect(buffer).toHaveCount(0);
  await button(page, 'Undo').tap(); await expect(buffer).toHaveAttribute('transform', /rotate\(90/);
  await page.locator('[data-pin="buf1.Y"]').tap();
  await expect(page.locator('[data-pin="buf1.Y"]')).toHaveClass(/pin-active/);
  await hold(page, await localPoint(page, 80, 260));
  await menu.getByRole('button', { name: 'Cancel action', exact: true }).tap();
  await expect(page.locator('.pin-active')).toHaveCount(0);
});

for (const viewport of [{ width: 390, height: 844 }, { width: 768, height: 1024 }]) {
  test(`canvas and expanded panels fit ${viewport.width}x${viewport.height} without horizontal page scroll`, async ({ page }, testInfo) => {
    await page.setViewportSize(viewport);
    await canvas(page).scrollIntoViewIfNeeded();
    const canvasTop = await canvas(page).evaluate(element => element.getBoundingClientRect().top + window.scrollY);
    const controlsTop = await page.locator('#controls').evaluate(element => element.getBoundingClientRect().top + window.scrollY);
    expect(controlsTop).toBeGreaterThan(canvasTop);
    await button(page, 'Probe net').tap(); await page.locator('[data-pin="clk.Y"]').tap();
    await page.locator('[data-comp-id="clk"] .gate-body').tap();
    for (const panel of ['palette', 'inspector', 'waveforms', 'testbench', 'file', 'chips', 'events']) await openPanel(page, panel);
    const fits = async (): Promise<void> => {
      const layout = await page.evaluate(() => ({
        width: document.documentElement.clientWidth,
        scrollWidth: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth),
        boxes: [...document.querySelectorAll<HTMLElement>('#schematic, #controls, .workspace-panel, #palette, #inspector, #waveforms, #testbench, #file, #chips')]
          .filter(element => element.getClientRects().length > 0)
          .map(element => { const box = element.getBoundingClientRect(); return { left: box.left, right: box.right }; }),
      }));
      expect(layout.scrollWidth).toBeLessThanOrEqual(layout.width + 1);
      for (const box of layout.boxes) { expect(box.left).toBeGreaterThanOrEqual(0); expect(box.right).toBeLessThanOrEqual(layout.width + 1); }
    };
    await fits();
    await testInfo.attach('expanded editor', { body: await page.screenshot({ fullPage: true }), contentType: 'image/png' });
    await button(page, 'Tutorial').tap();
    await expect(page.locator('#tutorial h2')).toContainText('1 / 7');
    // The microcode table is the widest lesson; include it in layout checks.
    for (let step = 0; step < 5; step++) await button(page, 'Skip step').tap();
    await expect(page.locator('#tutorial h2')).toContainText('6 / 7');
    await expect(page.getByRole('table', { name: 'ADD microcode', exact: true })).toBeVisible();
    await fits();
    await testInfo.attach('tutorial and panels', { body: await page.screenshot({ fullPage: true }), contentType: 'image/png' });
    await page.locator('.panel-tutorial > summary').tap();
    await expect(page.locator('#tutorial')).not.toBeVisible();
    await button(page, 'Tutorial').tap(); await expect(page.locator('#tutorial')).toBeVisible();
  });
}
