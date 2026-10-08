import { expect, test, type Page } from './fixtures';

const button = (page: Page, name: string) => page.getByRole('button', { name, exact: true });
async function circuitJSON(page: Page) {
  await button(page, 'Circuit JSON').click();
  const circuit = JSON.parse(await page.getByLabel('Circuit JSON', { exact: true }).inputValue());
  await button(page, 'Close JSON').click(); return circuit;
}
async function probe(page: Page, endpoint: string, bus = false) {
  await button(page, bus ? 'Probe bus' : 'Probe net').click();
  await page.locator(`[data-pin="${endpoint}"]`).click();
  await expect(button(page, bus ? 'Probe bus' : 'Probe net')).toHaveAttribute('aria-pressed', 'false');
}
async function outputs(page: Page): Promise<string[]> {
  return page.locator('[data-role="waveform"]').evaluate(svg => {
    const segments = (label: string) => {
      const row = Array.from(svg.querySelectorAll('g[aria-label]')).find(el => el.getAttribute('aria-label') === `Waveform ${label}`)!;
      return Array.from(row.querySelectorAll<SVGGElement>('[data-value]'), el => ({ start: Number(el.dataset.startTick), end: Number(el.dataset.endTick), value: el.dataset.value! }));
    };
    const data = segments('display.OUT[7:0]'); const clock = segments('display.CLK'); const enable = segments('display./OI');
    const at = (rows: ReturnType<typeof segments>, tick: number) => rows.find(row => row.start <= tick && tick < row.end)?.value;
    // Sample OUT writes, including a write of zero to the reset-zero display.
    return clock.filter(row => row.value === '1' && at(enable, row.start - 1) === '0').map(row => at(data, row.start)!);
  });
}

for (const [name, expected] of [
  ['sap1_count_up', ['00', '01', '02']],
  ['sap1_count_up_down', ['00', '01', '02']],
  ['sap1_multiply', ['2A']],
  ['sap1_arithmetic', ['04', 'FA', '00', '13']],
  ['sap1_halt', ['01', '02', '03']],
] as const) {
  test(`${name} loads by link and records its first OUT instructions`, async ({ page }) => {
    test.setTimeout(30_000);
    const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
    await page.goto(`/#example=${name}`); await button(page, 'Pause').click();
    await expect(page.locator('[data-comp-id="display"]')).toBeVisible();
    expect((await circuitJSON(page)).name).toBe(name);
    await button(page, 'Fit circuit').click();
    // At 100 ticks/s every instruction is recorded and the ring holds 81s.
    await page.getByLabel('Simulation ticks per second', { exact: true }).fill('100');
    await page.locator('[data-comp-id="clk_gen"] .gate-body').click();
    await page.locator('[data-field="params"]').fill('{"freqHz":50}');
    await button(page, 'Apply').click();
    await probe(page, 'display.OUT0', true);
    await probe(page, 'display.CLK'); await probe(page, 'display./OI');
    await page.locator('[data-comp-id="sw_reset"] .switch-handle').click();
    await button(page, 'Run').click();
    await expect.poll(async () => (await outputs(page)).slice(0, expected.length), { timeout: 15_000 }).toEqual([...expected]);
    await button(page, 'Pause').click();
    expect((await outputs(page)).slice(0, expected.length)).toEqual([...expected]);
    // The menu must reload the same named image after a run and discard probes.
    await page.locator('[data-file-action="examples"]').selectOption(name);
    await expect(page.getByLabel('Waveform display.OUT[7:0]', { exact: true })).toHaveCount(0);
    const fresh = await circuitJSON(page);
    expect(fresh.name).toBe(name);
    expect(fresh.components.find((component: { id: string }) => component.id === 'clk_gen').params).toEqual({ freqHz: 2 });
    expect(errors).toEqual([]);
  });
}
