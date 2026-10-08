// Editor surface area: palette, click-to-place. The blink demo is the default
// circuit on first load; these tests add components on top of it.

import { expect, test } from './fixtures';

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('svg[data-role="canvas"]')).toBeVisible();
});

for (const rotation of [0, 90, 180, 270]) {
  test(`wires meet rendered buffer and DFF pins at ${rotation} degrees`, async ({ page }) => {
    const circuit = { version: 1, kind: 'circuit', name: 'rotation geometry',
      components: [
        { id: 'buffer_source', type: 'prim.BUF', position: [20, 80] },
        { id: 'buffer', type: 'prim.BUF', position: [150, 80], rotation },
        { id: 'buffer_sink', type: 'prim.BUF', position: [400, 80] },
        { id: 'dff_source', type: 'prim.BUF', position: [20, 220] },
        { id: 'dff', type: 'prim.DFF', position: [150, 220], rotation },
        { id: 'dff_sink', type: 'prim.BUF', position: [400, 220] },
      ],
      nets: [
        { id: 'buffer_in', endpoints: ['buffer_source.Y', 'buffer.A'] },
        { id: 'buffer_out', endpoints: ['buffer.Y', 'buffer_sink.A'] },
        { id: 'dff_in', endpoints: ['dff_source.Y', 'dff.D'] },
        { id: 'dff_out', endpoints: ['dff.Q', 'dff_sink.A'] },
      ],
    };
    await page.locator('input[data-file-action="load-input"]').setInputFiles({
      name: 'rotation.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(circuit)),
    });
    await expect(page.locator('[data-comp-id="dff"]')).toBeVisible();
    await expect(page.locator('polyline.wire')).toHaveCount(4);
    const geometry = await page.locator('svg[data-role="canvas"]').evaluate(svg => {
      const connections = [
        { net: 'buffer_in', pin: 'buffer.A', end: -1 }, { net: 'buffer_out', pin: 'buffer.Y', end: 0 },
        { net: 'dff_in', pin: 'dff.D', end: -1 }, { net: 'dff_out', pin: 'dff.Q', end: 0 },
      ];
      return connections.map(({ net, pin, end }) => {
        const handle = svg.querySelector<SVGCircleElement>(`[data-pin="${pin}"]`)!;
        const wire = svg.querySelector<SVGPolylineElement>(`polyline[data-net-id="${net}"]`)!;
        const point = wire.points.getItem(end === 0 ? 0 : wire.points.numberOfItems - 1);
        // Browser-computed transforms include the SVG body rotation and viewport.
        const rendered = new DOMPoint(handle.cx.baseVal.value, handle.cy.baseVal.value).matrixTransform(handle.getScreenCTM()!);
        const endpoint = new DOMPoint(point.x, point.y).matrixTransform(wire.getScreenCTM()!);
        return { pin, rendered: [rendered.x, rendered.y], endpoint: [endpoint.x, endpoint.y] };
      });
    });
    for (const { pin, rendered, endpoint } of geometry) {
      expect(endpoint[0], `${pin} x`).toBeCloseTo(rendered[0]!, 3);
      expect(endpoint[1], `${pin} y`).toBeCloseTo(rendered[1]!, 3);
    }
  });
}

test('palette renders all entries grouped by category', async ({ page }) => {
  // Categories: I/O, Gates, Storage, Sources, Logic blocks, TTL, Memory, Eater.
  await expect(page.locator('.palette-group')).toHaveCount(8);
  // At least the core stdlib is exposed; tweak this if the palette grows again.
  const entryCount = await page.locator('.palette-entry').count();
  expect(entryCount).toBeGreaterThanOrEqual(35);
  // Spot-check entries from across the groups.
  await expect(page.locator('.palette-entry[data-palette-type="prim.AND"]')).toHaveText('AND');
  await expect(page.locator('.palette-entry[data-palette-type="io.led"]')).toHaveText('LED');
  await expect(page.locator('.palette-entry[data-palette-type="prim.DFF"]')).toHaveText('DFF');
  await expect(page.locator('.palette-entry[data-palette-type="ttl.74LS00"]')).toHaveText('74LS00');
  await expect(page.locator('.palette-entry[data-palette-type="mem.28C16"]')).toHaveText('28C16 EEPROM');
  await expect(page.locator('.palette-entry[data-palette-type="mem.74LS189"]')).toHaveText('74LS189 RAM');
  await expect(page.locator('.palette-entry[data-palette-type="eater.register_8bit"]')).toHaveText('8-bit register');
});

test('clicking a palette entry toggles aria-pressed', async ({ page }) => {
  const orBtn = page.locator('.palette-entry[data-palette-type="prim.OR"]');
  await expect(orBtn).toHaveAttribute('aria-pressed', 'false');
  await orBtn.click();
  await expect(orBtn).toHaveAttribute('aria-pressed', 'true');
  await orBtn.click();
  await expect(orBtn).toHaveAttribute('aria-pressed', 'false');
});

test('selecting a different palette entry switches placement', async ({ page }) => {
  const andBtn = page.locator('.palette-entry[data-palette-type="prim.AND"]');
  const orBtn = page.locator('.palette-entry[data-palette-type="prim.OR"]');
  await andBtn.click();
  await expect(andBtn).toHaveAttribute('aria-pressed', 'true');
  await orBtn.click();
  await expect(andBtn).toHaveAttribute('aria-pressed', 'false');
  await expect(orBtn).toHaveAttribute('aria-pressed', 'true');
});

test('palette + canvas click places a new component', async ({ page }) => {
  // M3 demo loads with 4 components — we are placing one more.
  await expect(page.locator('[data-comp-id]')).toHaveCount(4);
  await expect(page.locator('[data-comp-id="or1"]')).toHaveCount(0);

  await page.locator('.palette-entry[data-palette-type="prim.OR"]').click();
  await page.locator('svg[data-role="canvas"]').click({ position: { x: 200, y: 50 } });

  await expect(page.locator('[data-comp-id="or1"]')).toBeVisible();
  await expect(page.locator('[data-comp-id]')).toHaveCount(5);
  // Placement clears after the click.
  await expect(page.locator('.palette-entry[data-palette-type="prim.OR"]')).toHaveAttribute(
    'aria-pressed',
    'false',
  );
});

test('placing two of the same type generates distinct ids', async ({ page }) => {
  const andBtn = page.locator('.palette-entry[data-palette-type="prim.NAND"]');
  await andBtn.click();
  await page.locator('svg[data-role="canvas"]').click({ position: { x: 150, y: 30 } });
  await expect(page.locator('[data-comp-id="nand1"]')).toBeVisible();

  await andBtn.click();
  await page.locator('svg[data-role="canvas"]').click({ position: { x: 350, y: 30 } });
  await expect(page.locator('[data-comp-id="nand2"]')).toBeVisible();
});

test('placement does not toggle a switch when clicking on it', async ({ page }) => {
  // Switch label is "0" at start.
  await expect(page.locator('[data-comp-id="sw"] [data-role="switch-label"]')).toHaveText('0');

  // Enter placement mode and click on the switch — placement should win,
  // a new LED should appear, and the switch must remain in state 0.
  await page.locator('.palette-entry[data-palette-type="io.led"]').click();
  await page.locator('[data-comp-id="sw"]').click();

  await expect(page.locator('[data-comp-id="led1"]')).toBeVisible();
  await expect(page.locator('[data-comp-id="sw"] [data-role="switch-label"]')).toHaveText('0');
});

test('clicking two free pins creates a wire', async ({ page }) => {
  await page.locator('.palette-entry[data-palette-type="prim.OR"]').click();
  await page.locator('svg[data-role="canvas"]').click({ position: { x: 250, y: 50 } });
  await expect(page.locator('[data-comp-id="or1"]')).toBeVisible();

  const before = await page.locator('polyline.wire').count();
  await page.locator('[data-pin="or1.A"]').click();
  await expect(page.locator('[data-pin="or1.A"]')).toHaveClass(/pin-active/);
  await page.locator('[data-pin="or1.B"]').click();

  // A new 2-endpoint net adds exactly one polyline.
  await expect(page.locator('polyline.wire')).toHaveCount(before + 1);
  await expect(page.locator('[data-pin="or1.A"]')).not.toHaveClass(/pin-active/);
});

test('Esc cancels an in-progress wire', async ({ page }) => {
  await page.locator('.palette-entry[data-palette-type="prim.AND"]').click();
  await page.locator('svg[data-role="canvas"]').click({ position: { x: 250, y: 50 } });
  const before = await page.locator('polyline.wire').count();

  await page.locator('[data-pin="and1.A"]').click();
  await expect(page.locator('[data-pin="and1.A"]')).toHaveClass(/pin-active/);
  await page.keyboard.press('Escape');

  await expect(page.locator('[data-pin="and1.A"]')).not.toHaveClass(/pin-active/);
  await expect(page.locator('polyline.wire')).toHaveCount(before);
});

test('extending a net to a third endpoint adds a junction dot', async ({ page }) => {
  // Drop a second LED and tie it onto the existing `lit` net by clicking the
  // current `led.A` pin, then the fresh `led1.A` pin.
  await page.locator('.palette-entry[data-palette-type="io.led"]').click();
  await page.locator('svg[data-role="canvas"]').click({ position: { x: 480, y: 50 } });
  await expect(page.locator('[data-comp-id="led1"]')).toBeVisible();

  await expect(page.locator('circle.junction[data-net-id="lit"]')).toHaveCount(0);
  await page.locator('[data-pin="led.A"]').click();
  await page.locator('[data-pin="led1.A"]').click();

  // Three endpoints (and.Y, led.A, led1.A) → centroid junction dot.
  await expect(page.locator('circle.junction[data-net-id="lit"]')).toHaveCount(1);
  // Polylines for the lit net: one per endpoint = 3 segments.
  await expect(page.locator('polyline.wire[data-net-id="lit"]')).toHaveCount(3);
});

test('clicking a non-switch component selects it and populates the inspector', async ({ page }) => {
  await page.locator('[data-comp-id="and"]').click();
  await expect(page.locator('[data-comp-id="and"]')).toHaveAttribute('data-selected', 'true');
  // Inspector now shows id + type for the selection.
  await expect(page.locator('.inspector-form[data-inspector="and"]')).toBeVisible();
  await expect(page.locator('.inspector-readonly').first()).toHaveText('and');
});

test('clicking the canvas background clears selection', async ({ page }) => {
  await page.locator('[data-comp-id="and"]').click();
  await expect(page.locator('[data-comp-id="and"]')).toHaveAttribute('data-selected', 'true');
  // Click empty canvas area.
  await page.locator('svg[data-role="canvas"]').click({ position: { x: 30, y: 300 } });
  await expect(page.locator('[data-comp-id="and"]')).not.toHaveAttribute('data-selected', 'true');
});

test('Del removes a selected component', async ({ page }) => {
  // Place a fresh OR so we don't break the M3 demo.
  await page.locator('.palette-entry[data-palette-type="prim.OR"]').click();
  await page.locator('svg[data-role="canvas"]').click({ position: { x: 250, y: 50 } });
  await expect(page.locator('[data-comp-id="or1"]')).toBeVisible();

  await page.locator('[data-comp-id="or1"]').click();
  await expect(page.locator('[data-comp-id="or1"]')).toHaveAttribute('data-selected', 'true');
  await page.keyboard.press('Delete');

  await expect(page.locator('[data-comp-id="or1"]')).toHaveCount(0);
});

test('R rotates the selected component 90 degrees', async ({ page }) => {
  await page.locator('[data-comp-id="and"]').click();
  await page.keyboard.press('r');

  await expect
    .poll(() => page.locator('[data-comp-id="and"]').getAttribute('transform'))
    .toMatch(/rotate\(90/);

  await page.keyboard.press('r');
  await expect
    .poll(() => page.locator('[data-comp-id="and"]').getAttribute('transform'))
    .toMatch(/rotate\(180/);
});

test('inspector apply updates position and rotation', async ({ page }) => {
  await page.locator('[data-comp-id="and"]').click();
  await page.locator('.inspector-form input[data-field="x"]').fill('300');
  await page.locator('.inspector-form input[data-field="y"]').fill('80');
  await page.locator('.inspector-form select[data-field="rotation"]').selectOption('90');
  await page.locator('.inspector-form button[data-action="apply"]').click();

  await expect
    .poll(() => page.locator('[data-comp-id="and"]').getAttribute('transform'))
    .toMatch(/translate\(300 80\) rotate\(90/);
});

test('inspector delete button removes the component', async ({ page }) => {
  await page.locator('.palette-entry[data-palette-type="prim.NAND"]').click();
  await page.locator('svg[data-role="canvas"]').click({ position: { x: 350, y: 200 } });
  await page.locator('[data-comp-id="nand1"]').click();
  await page.locator('.inspector-form button[data-action="delete"]').click();
  await expect(page.locator('[data-comp-id="nand1"]')).toHaveCount(0);
});

test('Undo reverts the last placement; Redo replays it', async ({ page }) => {
  const undoBtn = page.locator('#controls button[data-action="undo"]');
  const redoBtn = page.locator('#controls button[data-action="redo"]');
  await expect(undoBtn).toBeDisabled();
  await expect(redoBtn).toBeDisabled();

  await page.locator('.palette-entry[data-palette-type="prim.OR"]').click();
  await page.locator('svg[data-role="canvas"]').click({ position: { x: 250, y: 100 } });
  await expect(page.locator('[data-comp-id="or1"]')).toBeVisible();
  await expect(undoBtn).toBeEnabled();

  await undoBtn.click();
  await expect(page.locator('[data-comp-id="or1"]')).toHaveCount(0);
  await expect(redoBtn).toBeEnabled();

  await redoBtn.click();
  await expect(page.locator('[data-comp-id="or1"]')).toBeVisible();
});

test('Cmd-Z / Cmd-Shift-Z drive undo and redo', async ({ page, browserName }) => {
  // Use platform-appropriate modifier; Playwright maps "Meta" to Cmd, "Control" to Ctrl.
  const mod = browserName === 'webkit' ? 'Meta' : 'Control';

  await page.locator('.palette-entry[data-palette-type="prim.NAND"]').click();
  await page.locator('svg[data-role="canvas"]').click({ position: { x: 300, y: 100 } });
  await expect(page.locator('[data-comp-id="nand1"]')).toBeVisible();

  await page.keyboard.press(`${mod}+KeyZ`);
  await expect(page.locator('[data-comp-id="nand1"]')).toHaveCount(0);

  await page.keyboard.press(`${mod}+Shift+KeyZ`);
  await expect(page.locator('[data-comp-id="nand1"]')).toBeVisible();
});

test('drag moves a component to a new grid-snapped position', async ({ page }) => {
  const and = page.locator('[data-comp-id="and"]');
  await expect(and).toHaveAttribute('transform', 'translate(240 130)');

  const box = await and.boundingBox();
  if (!box) throw new Error('component bbox unavailable');
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  await page.mouse.move(cx + 60, cy + 40, { steps: 12 });
  await page.mouse.up();

  // The drag commits via editor.updateComponent (async). Poll until we see
  // a snapped integer transform that differs from the original.
  await expect
    .poll(
      async () => {
        const t = await and.getAttribute('transform');
        if (!t || t === 'translate(240 130)') return false;
        return /^translate\(\d+ \d+\)$/.test(t);
      },
      { timeout: 5_000, intervals: [50, 100, 200] },
    )
    .toBe(true);

  const after = await and.getAttribute('transform');
  const m = /^translate\((\d+) (\d+)\)$/.exec(after!)!;
  const x = Number(m[1]);
  const y = Number(m[2]);
  expect(x % 10).toBe(0);
  expect(y % 10).toBe(0);
  expect(x).toBeGreaterThan(240);
  expect(y).toBeGreaterThan(130);
});
