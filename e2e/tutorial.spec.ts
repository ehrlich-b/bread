import { expect, test, type Page } from '@playwright/test';

const button = (page: Page, name: string) => page.getByRole('button', { name, exact: true });
const panel = (page: Page) => page.getByLabel('Eater CPU tutorial', { exact: true });
const completion = (page: Page) => page.getByLabel('Tutorial completion', { exact: true });
const live = (page: Page) => page.getByLabel('Tutorial live state', { exact: true });

async function ready(page: Page, number: number, title: string): Promise<void> {
  await expect(panel(page).getByRole('heading')).toHaveText(`${number} / 7 · ${title}`);
  await expect(completion(page)).toHaveText('Waiting for simulator state.');
  await expect(page.getByLabel('Simulation throughput', { exact: true })).toContainText('Paused');
}
async function steps(page: Page, count: number): Promise<void> {
  for (let tick = 0; tick < count; tick++) await button(page, 'Step').click();
}
async function checked(page: Page): Promise<void> {
  await expect(completion(page)).toContainText('Checked:');
  await expect(button(page, 'Next step')).toBeEnabled();
}
async function release(page: Page): Promise<void> {
  await page.locator('[data-comp-id="sw_reset"] .switch-handle').click();
  await expect(live(page)).toContainText('RESET released');
}
async function probe(page: Page, endpoint: string, bus = false): Promise<void> {
  const name = bus ? 'Probe bus' : 'Probe net';
  await button(page, name).click();
  await page.locator(`[data-pin="${endpoint}"]`).click();
  await expect(button(page, name)).toHaveAttribute('aria-pressed', 'false');
}

test('the #tutorial tour walks clock, bus, ALU, memory, microcode and Fibonacci through real controls', async ({ page }) => {
  test.setTimeout(60_000);
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto('/#tutorial');
  await ready(page, 1, 'Step and run the clock');
  await expect(page.locator('[data-comp-id="clk_gen"]')).toHaveAttribute('data-tutorial-focus', 'true');
  await expect(button(page, 'Next step')).toBeDisabled();
  await steps(page, 1); await expect(live(page)).toContainText('CLK 1');
  await expect(button(page, 'Next step')).toBeDisabled();
  await button(page, 'Run').click();
  // Wait for actual simulator ticks, not an arbitrary wall-clock delay.
  await expect.poll(async () => {
    const text = await page.getByLabel('Simulation throughput', { exact: true }).textContent();
    return Number((text?.match(/· ([\d,]+) ticks$/)?.[1] ?? '0').replaceAll(',', ''));
  }).toBeGreaterThan(1);
  await button(page, 'Pause').click(); await checked(page);

  await button(page, 'Next step').click(); await ready(page, 2, 'Probe CLK');
  await expect(page.locator('[data-comp-id="reg_a"]')).toHaveAttribute('data-tutorial-focus', 'true');
  await probe(page, 'reg_a.CLK'); await steps(page, 2); await checked(page);
  await expect(page.getByLabel('Waveform reg_a.CLK', { exact: true })).toBeVisible();

  await button(page, 'Next step').click(); await ready(page, 3, 'Load A from the bus');
  await release(page); await steps(page, 6); await checked(page);
  await expect(live(page)).toContainText('A 03');
  // Read the highlighted module through the public inspector too.
  await page.locator('[data-comp-id="reg_a"] .gate-body').click();
  await expect(page.getByLabel('Live VAL[7:0]', { exact: true })).toHaveText('03\n00000011');

  await button(page, 'Next step').click(); await ready(page, 4, 'Add A + B');
  await expect(page.locator('[data-comp-id="alu"]')).toHaveAttribute('data-tutorial-focus', 'true');
  await release(page); await steps(page, 20); await checked(page);
  await expect(live(page)).toContainText('A 05 · B 02');

  await button(page, 'Next step').click(); await ready(page, 5, 'Fetch from RAM with the PC');
  await expect(page.locator('[data-comp-id="pc"]')).toHaveAttribute('data-tutorial-focus', 'true');
  await release(page); await steps(page, 4); await checked(page);
  await expect(live(page)).toContainText('PC 1');

  await button(page, 'Next step').click(); await ready(page, 6, 'Follow one ADD instruction');
  await expect(page.getByLabel('ADD microcode', { exact: true }).locator('tr')).toHaveCount(5);
  await expect(page.locator('[data-comp-id="control"]')).toHaveAttribute('data-tutorial-focus', 'true');
  await release(page); await steps(page, 20); await checked(page);

  await button(page, 'Next step').click(); await ready(page, 7, 'Run Fibonacci on the waveform');
  await expect(button(page, 'Finish tutorial')).toBeDisabled();
  await expect(button(page, 'Check Fibonacci')).toBeDisabled();
  await probe(page, 'display.OUT0', true);
  await expect(button(page, 'Check Fibonacci')).toBeEnabled();
  await release(page); await button(page, 'Run').click();
  await expect(completion(page)).toContainText('233 in order.', { timeout: 20_000 });
  await button(page, 'Pause').click();
  await button(page, 'Fit waveform').click();
  await expect(page.getByLabel('Waveform display.OUT[7:0]', { exact: true }).locator('[data-value="E9"]').first()).toBeVisible();
  await button(page, 'Check Fibonacci').click();
  await expect(page.getByLabel('Tutorial testbench result', { exact: true })).toHaveText('PASS Fibonacci: 41/41 vectors');
  await expect(button(page, 'Finish tutorial')).toBeEnabled();
  await button(page, 'Finish tutorial').click(); await expect(panel(page)).toBeHidden();
  await expect(page.locator('[data-tutorial-focus="true"]')).toHaveCount(0);
  await page.reload(); await ready(page, 7, 'Run Fibonacci on the waveform');
  // Stored progress records prior checks; it cannot claim the fresh CPU ran.
  await expect(button(page, 'Finish tutorial')).toBeDisabled();
  await panel(page).getByText('Tutorial steps', { exact: true }).click();
  await expect(panel(page).locator('li[data-result="complete"]')).toHaveCount(7);
  expect(errors).toEqual([]);
});

test('UI opening, Back, Skip, resume, Reset and circuit-change recovery keep progress honest', async ({ page }) => {
  await page.goto('/'); await button(page, 'Tutorial').click();
  await ready(page, 1, 'Step and run the clock');
  await button(page, 'Skip step').click(); await ready(page, 2, 'Probe CLK');
  await button(page, 'Back step').click(); await ready(page, 1, 'Step and run the clock');
  await button(page, 'Skip step').click(); await ready(page, 2, 'Probe CLK');
  await button(page, 'Skip step').click(); await ready(page, 3, 'Load A from the bus');
  await button(page, 'Close tutorial').click();
  await page.reload(); await button(page, 'Tutorial').click(); await ready(page, 3, 'Load A from the bus');
  await panel(page).getByText('Tutorial steps', { exact: true }).click();
  await expect(panel(page).locator('li[data-result="skipped"]')).toHaveCount(2);
  await expect(button(page, 'Next step')).toBeDisabled();
  await page.locator('[data-file-action="examples"]').selectOption('blink_demo');
  await expect(completion(page)).toHaveText('Circuit changed. Restart step to continue.');
  await expect(page.locator('[data-tutorial-focus="true"]')).toHaveCount(0);
  await button(page, 'Restart step').click(); await ready(page, 3, 'Load A from the bus');
  await button(page, 'Reset tutorial').click(); await ready(page, 1, 'Step and run the clock');
  await expect(panel(page).locator('li[data-result="pending"]')).toHaveCount(7);
});

test('hash navigation opens the tour when browser storage is denied', async ({ page }) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => {
    Object.defineProperty(window, 'localStorage', { get: () => { throw new DOMException('Storage denied', 'SecurityError'); } });
  });
  await page.goto('/');
  await page.evaluate(() => { window.location.hash = '#tutorial'; });
  await ready(page, 1, 'Step and run the clock');
  await button(page, 'Skip step').click(); await ready(page, 2, 'Probe CLK');
  await button(page, 'Back step').click(); await ready(page, 1, 'Step and run the clock');
  await button(page, 'Reset tutorial').click(); await ready(page, 1, 'Step and run the clock');
  expect(errors).toEqual([]);
});
