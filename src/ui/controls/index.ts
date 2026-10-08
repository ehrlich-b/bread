// Run / Pause / Step / Undo / Redo buttons. Run/Pause/Step preserve their M3
// labels and order because the existing Playwright e2e asserts on them.
// Undo / Redo update their `disabled` state from editor stack depth.

import type { EditorModel } from '../editor';
import { SHORTCUTS, shortcutBlocked } from '../shortcuts';
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
  let running = false;
  let reportedRunning = false;
  let pendingTransport = 0;
  const transport = (nextRunning: boolean, action: () => Promise<void>): void => {
    running = nextRunning; pendingTransport++;
    void action().catch((reason: unknown) => {
      error.textContent = reason instanceof Error ? reason.message : String(reason);
    }).finally(() => {
      if (--pendingTransport === 0) running = reportedRunning;
    });
  };
  const runBtn = button('Run', () => {
    try {
      const rate = validateRateHz(Number(rateInput.value));
      error.textContent = '';
      transport(true, () => editor.run(rate));
    } catch (e) { error.textContent = e instanceof Error ? e.message : String(e); }
  });
  const pauseBtn = button('Pause', () => {
    transport(false, () => editor.pause());
  });
  const stepBtn = button('Step', () => {
    void editor.step().catch(() => {});
  });
  const undoBtn = button('Undo', () => {
    void editor.undo().catch(() => {});
  });
  undoBtn.dataset.action = 'undo';
  const redoBtn = button('Redo', () => {
    void editor.redo().catch(() => {});
  });
  redoBtn.dataset.action = 'redo';
  const busBtn = button('Connect bus', () => editor.setBusWiring(!editor.state.busWiring));
  busBtn.title = 'Click the lowest numbered pin on each component, then confirm the bit mapping.';
  const probeNet = button('Probe net', () => editor.setProbing(editor.state.probing === 'net' ? null : 'net'));
  const probeBus = button('Probe bus', () => editor.setProbing(editor.state.probing === 'bus' ? null : 'bus'));
  const probeHint = document.createElement('span'); probeHint.className = 'bus-hint';
  const busHint = document.createElement('span'); busHint.className = 'bus-hint';
  busHint.textContent = 'Bus wiring: click the lowest bit on two components, then confirm the mapping.';

  const help = document.createElement('dialog'); help.className = 'chip-dialog shortcuts-dialog';
  help.setAttribute('aria-label', 'Keyboard shortcuts');
  const title = document.createElement('h2'); title.textContent = 'Keyboard shortcuts';
  const table = document.createElement('table');
  for (const [keys, action] of SHORTCUTS) {
    const row = document.createElement('tr');
    const keyCell = document.createElement('td'); keyCell.textContent = keys;
    const actionCell = document.createElement('td'); actionCell.textContent = action;
    row.append(keyCell, actionCell); table.append(row);
  }
  const hint = document.createElement('p'); hint.textContent = 'Shortcuts are disabled while typing or while a dialog is open.';
  const closeHelp = button('Close shortcuts', () => help.close());
  help.append(title, table, hint, closeHelp); document.body.append(help);
  const showHelp = button('Keyboard shortcuts', () => help.showModal());
  const onKey = (event: KeyboardEvent): void => {
    if (shortcutBlocked(event) || event.repeat || event.ctrlKey || event.metaKey || event.altKey) return;
    if (event.key === ' ') {
      event.preventDefault();
      if (running) pauseBtn.click(); else runBtn.click();
    } else if (event.key === '.') {
      event.preventDefault(); stepBtn.click();
    } else if (event.key === '?') {
      event.preventDefault(); showHelp.click();
    }
  };
  document.addEventListener('keydown', onKey);

  const refresh = (): void => {
    undoBtn.disabled = !editor.canUndo();
    redoBtn.disabled = !editor.canRedo();
    busBtn.setAttribute('aria-pressed', String(editor.state.busWiring));
    busHint.hidden = !editor.state.busWiring;
    probeNet.setAttribute('aria-pressed', String(editor.state.probing === 'net'));
    probeBus.setAttribute('aria-pressed', String(editor.state.probing === 'bus'));
    probeHint.hidden = !editor.state.probing;
    probeHint.textContent = editor.state.probing === 'bus' ? 'Probe bus: click its lowest numbered pin. Escape cancels.' : 'Probe net: click a wire or pin. Escape cancels.';
  };
  refresh();

  host.append(runBtn, pauseBtn, stepBtn, undoBtn, redoBtn, busBtn, busHint, probeNet, probeBus, probeHint, rateLabel, status, error, showHelp);
  const unsubMetrics = editor.bus.on('metrics', (m) => {
    reportedRunning = m.running;
    if (pendingTransport === 0) running = reportedRunning;
    status.textContent = `${m.running ? 'Running' : 'Paused'} · requested ${m.targetRateHz.toLocaleString()} ticks/s · measured ${Math.round(m.actualRateHz).toLocaleString()} ticks/s · ${m.ticks.toLocaleString()} ticks`;
  });

  const unsub = editor.subscribe(refresh);
  return () => {
    host.innerHTML = '';
    unsub();
    unsubMetrics();
    document.removeEventListener('keydown', onKey);
    help.remove();
  };
};
