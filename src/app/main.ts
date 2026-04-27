// Main-thread entry. Spins up the worker, hands it the demo circuit, and
// wires the SVG schematic + control buttons. Net values are sampled from the
// SharedArrayBuffer at requestAnimationFrame; clicks and run/pause go back
// over postMessage.

import blinkDemo from '../../examples/blink_demo.json';
import type { CircuitJSON } from '../engine/ir';
import { mountSchematic } from '../ui/schematic';
import { createWorkerBus } from '../ui/bus';

const isoStatus = document.getElementById('iso-status')!;
isoStatus.textContent = self.crossOriginIsolated
  ? 'crossOriginIsolated: true'
  : 'crossOriginIsolated: false (SharedArrayBuffer disabled)';

const log = (msg: string): void => {
  const list = document.getElementById('event-log')!;
  const li = document.createElement('li');
  li.textContent = `${new Date().toLocaleTimeString()}  ${msg}`;
  list.prepend(li);
};

const main = async (): Promise<void> => {
  const bus = createWorkerBus();
  bus.on('event', (e) => log(`[${e.kind}] ${e.detail}`));

  const circuit = blinkDemo as CircuitJSON;
  const snapshot = await bus.load(circuit);
  log(`loaded ${circuit.name}: ${snapshot.netIds.length} nets, ${snapshot.componentIds.length} components`);

  mountSchematic(document.getElementById('schematic')!, circuit, snapshot, bus);

  const controls = document.getElementById('controls')!;
  const runBtn = button('Run', () => bus.run(1000));
  const pauseBtn = button('Pause', () => bus.pause());
  const stepBtn = button('Step', () => bus.step());
  controls.append(runBtn, pauseBtn, stepBtn);

  // Default to running so the LED actually blinks on first load.
  await bus.run(1000);
};

const button = (label: string, onClick: () => void): HTMLButtonElement => {
  const b = document.createElement('button');
  b.type = 'button';
  b.textContent = label;
  b.addEventListener('click', onClick);
  return b;
};

main().catch((err: unknown) => {
  log(`fatal: ${err instanceof Error ? err.message : String(err)}`);
});
