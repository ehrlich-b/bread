import fibonacciBench from '../../examples/testbenches/sap1_fibonacci.json';
import type { CircuitJSON } from '../engine/ir';
import type { WaveformSnapshot } from '../engine/probes';
import type { TestbenchJSON } from '../engine/testbench';
import { NET_STATE_FROM_BYTE } from '../worker/protocol';
import type { EditorModel } from './editor';
import {
  ADD_MICROCODE, readTutorialProgress, saveTutorialProgress, TUTORIAL_STEPS,
  TutorialClock, tutorialCircuit, tutorialComplete,
} from './tutorial';

const signature = ({ probes: _probes, ...body }: CircuitJSON): string => JSON.stringify(body);

export const mountTutorial = (host: HTMLElement, editor: EditorModel, canvas: HTMLElement): (() => void) => {
  host.hidden = true; host.setAttribute('aria-label', 'Eater CPU tutorial');
  const button = (label: string, action: () => void): HTMLButtonElement => {
    const el = document.createElement('button'); el.type = 'button'; el.textContent = label; el.addEventListener('click', action); return el;
  };
  let progress = readTutorialProgress();
  let opened = false;
  let busy = false;
  let ready = false;
  let matches = false;
  let done = false;
  let generation = 0;
  let disposed = false;
  let expected = '';
  let clock = new TutorialClock();
  let recording: WaveformSnapshot | null | undefined = null;
  let loadedSnapshot = editor.state.snapshot;
  const heading = document.createElement('h2'); heading.tabIndex = -1;
  const intro = document.createElement('small'); intro.textContent = 'Each step loads SAP-1 at reset. The lessons use LDI 3; ADD 15; OUT; HLT, with RAM[15] = 2; the last step restores Fibonacci. Undo restores your previous circuit.';
  const instruction = document.createElement('p');
  const live = document.createElement('output'); live.setAttribute('aria-label', 'Tutorial live state');
  const status = document.createElement('p'); status.setAttribute('role', 'status'); status.setAttribute('aria-label', 'Tutorial completion');
  const error = document.createElement('p'); error.setAttribute('role', 'alert');
  const benchResult = document.createElement('output'); benchResult.setAttribute('aria-label', 'Tutorial testbench result');
  const rows = document.createElement('table'); rows.setAttribute('aria-label', 'ADD microcode');
  const caption = document.createElement('caption'); caption.textContent = 'ADD 15 · a slash means active at 0'; rows.append(caption);
  for (const row of ADD_MICROCODE) {
    const tr = document.createElement('tr');
    row.forEach((text, index) => { const cell = document.createElement(index === 0 ? 'th' : 'td'); cell.textContent = text; tr.append(cell); });
    rows.append(tr);
  }
  const contents = document.createElement('details');
  const summary = document.createElement('summary'); summary.textContent = 'Tutorial steps';
  const list = document.createElement('ol');
  const items = TUTORIAL_STEPS.map(step => { const li = document.createElement('li'); li.textContent = step.title; list.append(li); return li; });
  contents.append(summary, list);
  const actions = document.createElement('div'); actions.className = 'tutorial-actions';

  const highlight = (): void => {
    const focus = opened && ready && matches ? TUTORIAL_STEPS[progress.step]!.focus : [];
    for (const group of canvas.querySelectorAll<SVGElement>('[data-comp-id]')) {
      if (focus.includes(group.dataset.compId!)) group.dataset.tutorialFocus = 'true';
      else delete group.dataset.tutorialFocus;
    }
  };
  const refresh = (): void => {
    const step = TUTORIAL_STEPS[progress.step]!;
    heading.textContent = `${progress.step + 1} / ${TUTORIAL_STEPS.length} · ${step.title}`;
    instruction.textContent = step.instruction;
    rows.hidden = step.id !== 'microcode';
    back.disabled = busy || progress.step === 0;
    skip.disabled = busy || progress.step === TUTORIAL_STEPS.length - 1;
    next.disabled = busy || !ready || !matches || !done;
    next.textContent = progress.step === TUTORIAL_STEPS.length - 1 ? 'Finish tutorial' : 'Next step';
    restart.disabled = busy; reset.disabled = busy;
    check.hidden = step.id !== 'fibonacci';
    check.disabled = busy || !ready || !matches || !editor.state.circuit.probes?.some(probe => probe.nets.length === 8 && probe.nets[0] === 'display__nlo0');
    const message = busy ? 'Loading…' : !ready || !matches ? 'Circuit changed. Restart step to continue.' : done ? `Checked: ${step.success}` : 'Waiting for simulator state.';
    if (status.textContent !== message) status.textContent = message;
    for (const [index, item] of items.entries()) {
      item.dataset.result = progress.results[index];
      if (index === progress.step) item.setAttribute('aria-current', 'step'); else item.removeAttribute('aria-current');
      item.textContent = `${TUTORIAL_STEPS[index]!.title} · ${progress.results[index]}`;
    }
    if (ready && matches) {
      const read = (net: string): string => {
        const index = editor.state.snapshot.netIndex.get(net);
        return index === undefined ? 'X' : ['0', '1', 'Z', 'X'][editor.state.snapshot.netsView[index]!] ?? 'X';
      };
      const word = (nets: string[]): string => {
        const binary = nets.map(read).reverse().join('');
        return /^[01]+$/.test(binary) ? Number.parseInt(binary, 2).toString(16).toUpperCase().padStart(Math.ceil(nets.length / 4), '0') : binary;
      };
      live.textContent = `CLK ${read('gated_clk')} · RESET ${read('reset_low') === '0' ? 'held' : 'released'} · A ${word(Array.from({ length: 8 }, (_, n) => `av${n}`))} · B ${word(Array.from({ length: 8 }, (_, n) => `bv${n}`))} · PC ${word(['pc__qa', 'pc__qb', 'pc__qc', 'pc__qd'])} · T ${word(['control__tq0', 'control__tq1', 'control__tq2'])}`;
    } else live.textContent = '';
    highlight();
  };
  const inspect = (): void => {
    if (opened && !busy && ready && matches && !done && tutorialComplete(TUTORIAL_STEPS[progress.step]!.id, recording, clock)) {
      done = true; progress.results[progress.step] = 'complete'; saveTutorialProgress(progress);
    }
    refresh();
  };
  const close = (): void => {
    opened = false; host.hidden = true; busy = false; ready = false; generation++;
    open.setAttribute('aria-expanded', 'false'); highlight(); open.focus();
  };
  const prepare = (step: number): void => {
    progress.step = step; saveTutorialProgress(progress);
    const token = ++generation;
    busy = true; ready = false; done = false; clock = new TutorialClock(); recording = null;
    error.textContent = ''; benchResult.textContent = '';
    editor.clearPlacement(); editor.setProbing(null); editor.setBusWiring(false); editor.clearSelection();
    const circuit = tutorialCircuit(TUTORIAL_STEPS[step]!.id); expected = signature(circuit);
    refresh();
    // Reserve a document load immediately. A later file/example action wins
    // even if Pause is still waiting behind another editor RPC.
    void editor.loadCircuit(editor.pause().then(() => token === generation && !disposed ? circuit : null)).then(() => {
      if (token !== generation || disposed) return;
      ready = true; matches = signature(editor.state.circuit) === expected;
      loadedSnapshot = editor.state.snapshot; recording = editor.bus.waveform;
      canvas.querySelector<HTMLButtonElement>('.schematic-fit')?.click();
      heading.focus();
    }).catch((reason: unknown) => {
      if (token === generation && !disposed) error.textContent = reason instanceof Error ? reason.message : String(reason);
    }).finally(() => {
      if (token === generation && !disposed) { busy = false; inspect(); }
    });
  };
  const show = (): void => {
    if (opened) { heading.focus(); return; }
    opened = true; host.hidden = false; open.setAttribute('aria-expanded', 'true'); prepare(progress.step);
  };
  const open = button('Tutorial', show); open.setAttribute('aria-expanded', 'false'); open.setAttribute('aria-controls', host.id);
  document.querySelector('header')!.append(open);
  const back = button('Back step', () => prepare(progress.step - 1));
  const next = button('Next step', () => { if (progress.step === TUTORIAL_STEPS.length - 1) close(); else prepare(progress.step + 1); });
  const skip = button('Skip step', () => {
    if (progress.results[progress.step] !== 'complete') progress.results[progress.step] = 'skipped';
    prepare(progress.step + 1);
  });
  const restart = button('Restart step', () => prepare(progress.step));
  const reset = button('Reset tutorial', () => {
    progress = { step: 0, results: TUTORIAL_STEPS.map(() => 'pending') }; prepare(0);
  });
  const check = button('Check Fibonacci', () => {
    const token = generation; const circuit = editor.state.circuit;
    busy = true; error.textContent = ''; refresh();
    void editor.runTestbench(fibonacciBench as TestbenchJSON).then(result => {
      if (disposed || token !== generation || editor.state.circuit !== circuit) return;
      benchResult.textContent = `${result.passed === result.total ? 'PASS' : 'FAIL'} Fibonacci: ${result.passed}/${result.total} vectors`;
      recording = result.waveform;
      if (recording) editor.focusWaveform(recording, recording.ticks[0] ?? 0);
    }).catch((reason: unknown) => {
      if (token === generation && !disposed) error.textContent = reason instanceof Error ? reason.message : String(reason);
    }).finally(() => {
      if (token === generation && !disposed) { busy = false; inspect(); }
    });
  });
  actions.append(back, next, skip, restart, reset, button('Close tutorial', close));
  host.append(heading, intro, instruction, live, rows, status, error, check, benchResult, actions, contents);
  const unsubEditor = editor.subscribe(() => {
    if (!opened) return;
    matches = signature(editor.state.circuit) === expected;
    if (ready && loadedSnapshot !== editor.state.snapshot) {
      if (!editor.state.snapshot.preserved) { done = false; clock = new TutorialClock(); }
      loadedSnapshot = editor.state.snapshot; recording = editor.bus.waveform;
    }
    inspect();
  });
  const unsubMetrics = editor.bus.on('metrics', metrics => {
    if (!opened || busy || !ready || !matches) return;
    const snapshot = editor.state.snapshot;
    const index = snapshot.netIndex.get('gated_clk');
    if (index !== undefined) clock.observe(metrics, NET_STATE_FROM_BYTE[snapshot.netsView[index]!]!);
    inspect();
  });
  const unsubWaveform = editor.bus.on('waveform', snapshot => {
    if (!opened || busy || !ready || !matches) return;
    recording = snapshot; inspect();
  });
  const onHash = (): void => { if (window.location.hash === '#tutorial') show(); };
  window.addEventListener('hashchange', onHash); onHash();
  return () => {
    disposed = true; opened = false; generation++; highlight();
    unsubEditor(); unsubMetrics(); unsubWaveform(); window.removeEventListener('hashchange', onHash);
    open.remove(); host.replaceChildren(); host.hidden = true;
  };
};
