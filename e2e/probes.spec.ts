import { expect, test, type Page } from './fixtures';

const button = (page: Page, name: string) => page.getByRole('button', { name, exact: true });
const waveform = (page: Page, label: string) => page.getByLabel(`Waveform ${label}`, { exact: true });
async function exportJSON(page: Page): Promise<string> {
  await button(page, 'Circuit JSON').click();
  const text = await page.getByRole('textbox', { name: 'Circuit JSON', exact: true }).inputValue();
  await button(page, 'Close JSON').click(); return text;
}
async function attach(page: Page, endpoint: string, bus = false): Promise<void> {
  await button(page, bus ? 'Probe bus' : 'Probe net').click();
  await page.locator(`[data-pin="${endpoint}"]`).click();
  await expect(button(page, bus ? 'Probe bus' : 'Probe net')).toHaveAttribute('aria-pressed', 'false');
}

test('canvas probes persist through undo, redo, save and reopen; pause and step update the cursor', async ({ page }) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto('/'); await button(page, 'Pause').click();
  await page.locator('[data-file-action="examples"]').selectOption('blink_demo');
  await expect(page.locator('[data-pin="clk.Y"]')).toBeVisible();
  await attach(page, 'clk.Y');
  await expect(waveform(page, 'clk.Y')).toBeVisible();
  await expect(page.locator('[data-pin="clk.Y"]')).toHaveAttribute('data-probed', 'true');
  await page.getByLabel('Waveform cursor tick', { exact: true }).fill('0');
  await expect(page.getByLabel('Cursor clk.Y', { exact: true })).toHaveText('0 (0)');
  await button(page, 'Step').click();
  await expect(page.getByLabel('Waveform capture', { exact: true })).toContainText('ticks 0–1');
  await page.getByLabel('Waveform cursor tick', { exact: true }).fill('1');
  await expect(page.getByLabel('Cursor clk.Y', { exact: true })).toHaveText('0 (0)');
  await button(page, 'Undo').click(); await expect(waveform(page, 'clk.Y')).toHaveCount(0);
  await button(page, 'Redo').click(); await expect(waveform(page, 'clk.Y')).toBeVisible();
  const saved = await exportJSON(page);
  expect(JSON.parse(saved).probes).toEqual([{ id: 'probe1', label: 'clk.Y', nets: ['clk_out'] }]);
  await button(page, 'Remove probe clk.Y').click(); await expect(waveform(page, 'clk.Y')).toHaveCount(0);
  await button(page, 'Undo').click(); await expect(waveform(page, 'clk.Y')).toBeVisible();
  await page.reload(); await button(page, 'Pause').click();
  await page.locator('input[data-file-action="load-input"]').setInputFiles({ name: 'probed-blink.json', mimeType: 'application/json', buffer: Buffer.from(saved) });
  await expect(waveform(page, 'clk.Y')).toBeVisible();
  expect(JSON.parse(await exportJSON(page)).probes).toEqual(JSON.parse(saved).probes);
  await button(page, 'Zoom waveform in').click(); await button(page, 'Zoom waveform out').click();
  await button(page, 'Fit waveform').click();
  expect(errors).toEqual([]);
});

test('SAP-1 waveform captures the ordered Fibonacci OUT values, including both initial ones', async ({ page }) => {
  test.setTimeout(45_000);
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto('/'); await button(page, 'Pause').click();
  await page.locator('[data-file-action="examples"]').selectOption('ben_eater_8bit');
  await expect(page.locator('[data-comp-id="display"]')).toBeVisible();
  await button(page, 'Fit circuit').click();
  // Speed the ordinary configurable clock up so a complete cycle fits the
  // bounded recording, using the same public inspector workflow as a user.
  await page.locator('[data-comp-id="clk_gen"] .gate-body').click();
  await page.locator('[data-field="params"]').fill('{"freqHz":500}');
  await button(page, 'Apply').click();
  await attach(page, 'display.OUT0', true);
  await attach(page, 'display.CLK');
  await attach(page, 'display./OI');
  await expect(waveform(page, 'display.OUT[7:0]')).toBeVisible();
  expect(JSON.parse(await exportJSON(page)).probes[0].nets).toEqual(['display__nlo0', 'display__nlo1', 'display__nlo2', 'display__nlo3', 'display__nhi0', 'display__nhi1', 'display__nhi2', 'display__nhi3']);
  await page.locator('[data-comp-id="sw_reset"] .switch-handle').click();
  await button(page, 'Run').click();
  await expect(waveform(page, 'display.OUT[7:0]').locator('[data-value="E9"]')).toHaveCount(1, { timeout: 20_000 });
  await button(page, 'Pause').click();
  await expect(page.getByLabel('Waveform capture', { exact: true })).toContainText('Paused');
  await button(page, 'Fit waveform').click();
  // Read the rendered segments at each OUT load edge. Consecutive identical
  // register values share a segment, while the CLK and /OI probes preserve
  // both OUT instructions which write the first 1.
  const outputs = await page.locator('[data-role="waveform"]').evaluate(svg => {
    const segments = (label: string) => {
      const row = Array.from(svg.querySelectorAll('g[aria-label]')).find(el => el.getAttribute('aria-label') === `Waveform ${label}`)!;
      return Array.from(row.querySelectorAll<SVGGElement>('[data-value]'), el => ({ start: Number(el.dataset.startTick), end: Number(el.dataset.endTick), value: el.dataset.value! }));
    };
    const data = segments('display.OUT[7:0]'); const clock = segments('display.CLK'); const enable = segments('display./OI');
    const at = (rows: ReturnType<typeof segments>, tick: number) => rows.find(row => row.start <= tick && tick < row.end)?.value;
    return clock.filter(row => row.value === '1' && at(enable, row.start - 1) === '0').map(row => ({ tick: row.start, value: at(data, row.start) }));
  });
  expect(outputs.slice(0, 13).map(output => output.value)).toEqual(['01', '01', '02', '03', '05', '08', '0D', '15', '22', '37', '59', '90', 'E9']);
  await page.getByLabel('Waveform cursor tick', { exact: true }).fill(String(outputs[2]!.tick));
  await expect(page.getByLabel('Cursor display.OUT[7:0]', { exact: true })).toHaveText('02 (00000010)');
  const paused = await page.getByLabel('Waveform capture', { exact: true }).textContent();
  await button(page, 'Step').click();
  await expect(page.getByLabel('Waveform capture', { exact: true })).not.toHaveText(paused!);
  const saved = await exportJSON(page);
  await page.reload(); await button(page, 'Pause').click();
  await page.locator('input[data-file-action="load-input"]').setInputFiles({ name: 'sap1-probes.json', mimeType: 'application/json', buffer: Buffer.from(saved) });
  await expect(waveform(page, 'display.OUT[7:0]')).toBeVisible();
  await page.getByLabel('Waveform cursor tick', { exact: true }).fill('0');
  await expect(page.getByLabel('Cursor display.OUT[7:0]', { exact: true })).toHaveText('00 (00000000)');
  expect(errors).toEqual([]);
});
