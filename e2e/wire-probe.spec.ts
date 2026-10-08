import { expect, test, type Page } from './fixtures';

const button = (page: Page, name: string) => page.getByRole('button', { name, exact: true });
const canvas = (page: Page) => page.locator('svg[data-role="canvas"]');

async function wirePoint(page: Page, offset = 0): Promise<{ x: number; y: number }> {
  await canvas(page).scrollIntoViewIfNeeded();
  const point = await canvas(page).evaluate(svg => {
    const ctm = (svg as SVGSVGElement).getScreenCTM();
    if (!ctm) throw new Error('Canvas transform unavailable');
    const client = new DOMPoint(370, 150).matrixTransform(ctm);
    return { x: client.x, y: client.y };
  });
  return { x: point.x, y: point.y + offset };
}

for (const mode of ['desktop', 'phone', 'tablet'] as const) {
  test.describe(mode, () => {
    const mobile = mode !== 'desktop';
    test.use(mobile
      ? { hasTouch: true, isMobile: true, viewport: mode === 'phone' ? { width: 390, height: 844 } : { width: 768, height: 1024 } }
      : { viewport: { width: 1440, height: 900 } });

    const click = async (page: Page, point: { x: number; y: number }): Promise<void> => {
      if (mobile) await page.touchscreen.tap(point.x, point.y);
      else await page.mouse.click(point.x, point.y);
    };

    test.beforeEach(async ({ page }) => {
      await page.goto('/'); await button(page, 'Pause').click();
      await expect(page.locator('[data-comp-id="and"]')).toBeVisible();
    });

    for (const offset of [0, 6]) {
      test(`probe an ordinary wire ${offset === 0 ? 'at its midpoint' : 'within its wider hit area'}`, async ({ page }) => {
        await button(page, 'Probe net').click();
        await click(page, await wirePoint(page, offset));
        await expect(button(page, 'Probe net')).toHaveAttribute('aria-pressed', 'false');
        await expect(page.getByLabel('Waveform lit', { exact: true })).toBeVisible();
        await expect(page.locator('polyline.wire[data-net-id="lit"]')).toHaveAttribute('data-probed', 'true');
        await expect(page.getByRole('button', { name: 'Remove probe lit', exact: true })).toHaveCount(1);
      });
    }

    test('wire clicks clear selection and cancel wiring outside probe mode', async ({ page }) => {
      const gate = page.locator('[data-comp-id="and"]');
      if (mobile) await gate.locator('.gate-body').tap();
      else await gate.locator('.gate-body').click();
      await expect(gate).toHaveAttribute('data-selected', 'true');
      await click(page, await wirePoint(page));
      await expect(gate).not.toHaveAttribute('data-selected', 'true');
      if (mobile) await page.locator('[data-pin="and.Y"]').tap();
      else await page.locator('[data-pin="and.Y"]').click();
      await expect(page.locator('[data-pin="and.Y"]')).toHaveClass(/pin-active/);
      await click(page, await wirePoint(page));
      await expect(page.locator('.pin-active')).toHaveCount(0);
      await expect(page.locator('[data-probed="true"]')).toHaveCount(0);
    });

    if (mobile) {
      test('pan and pinch starting on a wire preserve selection and probe mode', async ({ page }) => {
        const gate = page.locator('[data-comp-id="and"]');
        await gate.locator('.gate-body').tap();
        const original = await gate.getAttribute('transform');
        await button(page, 'Probe net').tap();
        await expect(button(page, 'Undo')).toBeDisabled();
        const session = await page.context().newCDPSession(page);
        try {
          const startView = await canvas(page).getAttribute('viewBox');
          const point = await wirePoint(page, 6);
          await session.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ ...point, id: 1 }] });
          await session.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: point.x + 20, y: point.y + 25, id: 1 }] });
          await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
          await expect(canvas(page)).not.toHaveAttribute('viewBox', startView!);

          const first = await wirePoint(page);
          const second = { x: first.x + 50, y: first.y };
          const panned = (await canvas(page).getAttribute('viewBox'))!.split(' ').map(Number);
          await session.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ ...first, id: 1 }] });
          await session.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ ...first, id: 1 }, { ...second, id: 2 }] });
          await session.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: first.x - 15, y: first.y, id: 1 }, { x: second.x + 15, y: second.y, id: 2 }] });
          await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
          const zoomed = (await canvas(page).getAttribute('viewBox'))!.split(' ').map(Number);
          expect(zoomed[2]!).toBeLessThan(panned[2]!);
          await expect(gate).toHaveAttribute('transform', original!);
          await expect(gate).toHaveAttribute('data-selected', 'true');
          await expect(button(page, 'Probe net')).toHaveAttribute('aria-pressed', 'true');
          await expect(button(page, 'Undo')).toBeDisabled();
          await expect(page.locator('[data-probed="true"]')).toHaveCount(0);
        } finally { await session.detach(); }
      });

      test('long press offers the wire net without a stray probe', async ({ page }) => {
        const session = await page.context().newCDPSession(page);
        try {
          const point = await wirePoint(page, 6);
          await session.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ ...point, id: 1, radiusX: 8, radiusY: 8 }] });
          const menu = page.getByRole('dialog', { name: 'Canvas actions', exact: true });
          await expect(menu).toBeVisible();
          await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
          await expect(page.locator('[data-probed="true"]')).toHaveCount(0);
          await menu.getByRole('button', { name: 'Probe net', exact: true }).tap();
          await expect(page.getByLabel('Waveform lit', { exact: true })).toBeVisible();
        } finally { await session.detach(); }
      });
    }
  });
}
