// Main-thread entry. Spins up the worker, loads the demo circuit, builds an
// EditorModel, and mounts the schematic / controls / inspector views against
// it. Net values are sampled from the SharedArrayBuffer at rAF inside the
// schematic; clicks and run/pause/step go back over postMessage via the bus.

import blinkDemo from '../../examples/blink_demo.json';
import type { CircuitJSON } from '../engine/ir';
import { mountChips } from '../ui/chips';
import { createWorkerBus } from '../ui/bus';
import { mountControls } from '../ui/controls';
import { EditorModel } from '../ui/editor';
import { mountFileControls } from '../ui/file';
import { mountInspector } from '../ui/inspector';
import { mountPalette } from '../ui/palette';
import { mountWaveform } from '../ui/waveform_view';
import { mountSchematic } from '../ui/schematic';

const isoStatus = document.getElementById('iso-status')!;
if (!self.crossOriginIsolated) {
  isoStatus.textContent = 'SharedArrayBuffer disabled (no cross-origin isolation)';
}

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

  const editor = new EditorModel(bus, circuit, snapshot);

  mountPalette(document.getElementById('palette')!, editor);
  mountSchematic(document.getElementById('schematic')!, editor);
  mountControls(document.getElementById('controls')!, editor);
  mountFileControls(document.getElementById('file')!, editor);
  mountChips(document.getElementById('chips')!, editor);
  mountInspector(document.getElementById('inspector')!, editor);
  mountWaveform(document.getElementById('waveforms')!, editor);

  // Default to running so the LED actually blinks on first load.
  await bus.run(1000);
};

main().catch((err: unknown) => {
  log(`fatal: ${err instanceof Error ? err.message : String(err)}`);
});
