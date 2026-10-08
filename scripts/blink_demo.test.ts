import { expect, it, vi } from 'vitest';

it('checks the settled blink demo phase and exits successfully', async () => {
  let output = '';
  const exitCode = process.exitCode;
  vi.spyOn(process.stdout, 'write').mockImplementation(chunk => { output += String(chunk); return true; });
  vi.spyOn(process.stderr, 'write').mockImplementation(chunk => { output += String(chunk); return true; });
  process.exitCode = undefined;
  try {
    await import('./blink_demo');
    expect(process.exitCode, output).toBeUndefined();
    expect(output).toContain('blink_demo: OK');
  } finally {
    process.exitCode = exitCode;
    vi.restoreAllMocks();
  }
});
