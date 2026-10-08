import { parseTestbench, type TestbenchJSON, type VectorResult } from '../engine/testbench';
import type { EditorModel } from './editor';

export const mountTestbench = (host: HTMLElement, editor: EditorModel): (() => void) => {
  host.setAttribute('aria-label', 'Testbench panel');
  const title = document.createElement('strong'); title.textContent = 'Testbench';
  const hint = document.createElement('p'); hint.textContent = 'Load or paste JSON to test the open circuit from power-on state. Running pauses the circuit.';
  const file = document.createElement('input'); file.type = 'file'; file.accept = '.json,application/json'; file.setAttribute('aria-label', 'Load testbench');
  const text = document.createElement('textarea'); text.rows = 6; text.spellcheck = false; text.setAttribute('aria-label', 'Testbench JSON'); text.placeholder = 'Paste testbench JSON';
  const run = document.createElement('button'); run.type = 'button'; run.textContent = 'Run testbench';
  const status = document.createElement('output'); status.setAttribute('aria-label', 'Testbench result'); status.setAttribute('aria-live', 'polite');
  const error = document.createElement('p'); error.setAttribute('role', 'alert');
  const results = document.createElement('ol'); results.setAttribute('aria-label', 'Testbench vectors');
  let circuit = editor.state.circuit;
  let generation = 0;
  let disposed = false;
  const clear = (): void => { generation++; status.textContent = ''; error.textContent = ''; results.replaceChildren(); };
  text.addEventListener('input', clear);
  file.addEventListener('change', () => {
    const selected = file.files?.[0];
    if (!selected) return;
    clear(); const version = generation;
    void selected.text().then(value => {
      if (disposed || version !== generation) return;
      text.value = value;
      try { status.textContent = `Loaded ${parseTestbench(JSON.parse(value)).name}`; }
      catch (e) { error.textContent = e instanceof Error ? e.message : String(e); }
    }).catch(e => { if (!disposed && version === generation) error.textContent = String(e); });
    file.value = '';
  });
  run.addEventListener('click', () => {
    clear(); const version = generation;
    let bench: TestbenchJSON;
    try { bench = parseTestbench(JSON.parse(text.value)); }
    catch (e) { error.textContent = e instanceof Error ? e.message : String(e); return; }
    run.disabled = true; status.textContent = 'Running testbench…';
    const request = editor.runTestbench(bench);
    const commandRevision = editor.commandRevision;
    void request.then(result => {
      if (disposed || version !== generation) return;
      const failed = result.results.length - result.passed;
      status.textContent = `${failed ? 'FAIL' : 'PASS'} ${result.name}: ${result.passed}/${result.total} vectors${failed ? ` · ${failed} failed` : ''}`;
      const focus = async (vector: VectorResult, automatic: boolean): Promise<void> => {
        let waveform = result.waveform;
        if (!waveform || (automatic && editor.commandRevision !== commandRevision)) return;
        // The testbench already paused. Automatic focus must yield to commands
        // requested since it started; explicit inspection may pause again.
        const pause = automatic ? Promise.resolve() : editor.pause();
        const focusRevision = editor.commandRevision;
        await pause;
        if (disposed || version !== generation || editor.commandRevision !== focusRevision) return;
        // Replay an evicted failure so every failing vector remains inspectable
        // without making the ordinary waveform ring unbounded.
        if (vector.step < waveform.ticks[0]!) {
          const replay = editor.runTestbench(bench, vector.vector);
          const replayRevision = editor.commandRevision;
          waveform = (await replay).waveform;
          if (editor.commandRevision !== replayRevision) return;
        }
        if (!disposed && version === generation && waveform) editor.focusWaveform(waveform, vector.step);
      };
      const show = (vector: VectorResult, automatic = false): void => {
        void focus(vector, automatic).catch(e => { if (!disposed && version === generation) error.textContent = e instanceof Error ? e.message : String(e); });
      };
      for (const vector of result.results) {
        const row = document.createElement('li'); row.dataset.passed = String(vector.passed);
        const label = document.createElement('span'); label.textContent = `${vector.passed ? 'PASS' : 'FAIL'} ${vector.vector}: ${vector.label} · step ${vector.step}`;
        row.append(label);
        if (!vector.passed) {
          const details = document.createElement('pre');
          details.textContent = [`inputs: ${JSON.stringify(vector.drive)}`, vector.reason, ...vector.mismatches.map(name => `${name}: expected ${vector.expected[name]}, actual ${vector.actual[name]}`)].filter(Boolean).join('\n');
          row.append(details);
          if (result.waveform) {
            const jump = document.createElement('button'); jump.type = 'button'; jump.textContent = `Show failing vector ${vector.vector}`;
            jump.addEventListener('click', () => show(vector)); row.append(jump);
          }
        }
        results.append(row);
      }
      const failure = result.results.find(vector => !vector.passed);
      if (failure) show(failure, true);
    }).catch(e => {
      if (!disposed && version === generation) { status.textContent = ''; error.textContent = e instanceof Error ? e.message : String(e); }
    }).finally(() => { if (!disposed) run.disabled = false; });
  });
  const unsub = editor.subscribe(state => {
    if (state.circuit !== circuit) { circuit = state.circuit; clear(); }
  });
  host.append(title, hint, file, text, run, status, error, results);
  return () => { disposed = true; generation++; unsub(); host.replaceChildren(); };
};
