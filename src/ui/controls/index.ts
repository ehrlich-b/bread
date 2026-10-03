// Run / Pause / Step / Undo / Redo buttons. Run/Pause/Step preserve their M3
// labels and order because the existing Playwright e2e asserts on them.
// Undo / Redo update their `disabled` state from editor stack depth.

import type { EditorModel } from '../editor';
import { MAX_RATE_HZ, validateRateHz } from '../../worker/protocol';

const button = (label: string, onClick: () => void): HTMLButtonElement => {
  const b = document.createElement('button');
  b.type = 'button';
  b.textContent = label;
  b.addEventListener('click', onClick);
  return b;
};

export const mountControls = (host: HTMLElement, editor: EditorModel): (() => void) => {
  host.innerHTML = '';
  const rateLabel = document.createElement('label');
  rateLabel.textContent = 'Ticks / s ';
  const rateInput = document.createElement('input');
  rateInput.type = 'number'; rateInput.min = '1'; rateInput.max = String(MAX_RATE_HZ); rateInput.step = '1'; rateInput.value = '1000';
  rateInput.setAttribute('aria-label', 'Simulation ticks per second');
  rateInput.title = 'Requested engine ticks per second. Set each clock component frequency in its inspector.';
  rateLabel.append(rateInput);
  const status = document.createElement('output');
  status.setAttribute('aria-label', 'Simulation throughput');
  status.textContent = 'Waiting for simulation rate';
  const error = document.createElement('span'); error.setAttribute('role', 'alert');
  const runBtn = button('Run', () => {
    try {
      const rate = validateRateHz(Number(rateInput.value));
      error.textContent = '';
      void editor.bus.run(rate).catch((e: unknown) => { error.textContent = e instanceof Error ? e.message : String(e); });
    } catch (e) { error.textContent = e instanceof Error ? e.message : String(e); }
  });
  const pauseBtn = button('Pause', () => {
    void editor.bus.pause();
  });
  const stepBtn = button('Step', () => {
    void editor.bus.step();
  });
  const undoBtn = button('Undo', () => {
    void editor.undo();
  });
  undoBtn.dataset.action = 'undo';
  const redoBtn = button('Redo', () => {
    void editor.redo();
  });
  redoBtn.dataset.action = 'redo';

  const refresh = (): void => {
    undoBtn.disabled = !editor.canUndo();
    redoBtn.disabled = !editor.canRedo();
  };
  refresh();

  host.append(runBtn, pauseBtn, stepBtn, undoBtn, redoBtn, rateLabel, status, error);
  const unsubMetrics = editor.bus.on('metrics', (m) => {
    status.textContent = `${m.running ? 'Running' : 'Paused'} · requested ${m.targetRateHz.toLocaleString()} ticks/s · measured ${Math.round(m.actualRateHz).toLocaleString()} ticks/s · ${m.ticks.toLocaleString()} ticks`;
  });

  const unsub = editor.subscribe(refresh);
  return () => {
    host.innerHTML = '';
    unsub();
    unsubMetrics();
  };
};
