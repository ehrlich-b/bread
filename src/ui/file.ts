// Save and Load buttons + bundled examples menu. Save/Load uses the File
// System Access API (showSaveFilePicker / showOpenFilePicker) when available;
// falls back to `<a download>` for save and a hidden `<input type=file>` for
// load. The input is mounted into the DOM (not dynamically created) so
// Playwright can drive it via setInputFiles().
//
// The Examples dropdown ships every checked-in `examples/*.json` so a user can
// switch between canned circuits without leaving the page. Picking an entry
// runs `replaceCircuit`, which reuses the same mutate path as drag-edits and
// records an undo entry — Cmd-Z reverts back to whatever was on screen.

import benEater8bit from '../../examples/ben_eater_8bit.json';
import blinkDemo from '../../examples/blink_demo.json';
import fullAdder from '../../examples/full_adder.json';
import hexDisplay28C16 from '../../examples/hex_display_28c16.json';
import nandLatch from '../../examples/nand_latch.json';
import originalDigitalCpu from '../../examples/original_digital_cpu_generated.json';
import registerBus from '../../examples/register_bus_4bit.json';
import rippleAdder from '../../examples/ripple_adder_4bit.json';
import type { CircuitJSON } from '../engine/ir';
import type { EditorModel } from './editor';

interface BundledExample {
  key: string;
  label: string;
  circuit: CircuitJSON;
}

const EXAMPLES: BundledExample[] = [
  { key: 'blink_demo', label: 'Blink demo', circuit: blinkDemo as CircuitJSON },
  { key: 'full_adder', label: '1-bit full adder', circuit: fullAdder as CircuitJSON },
  { key: 'nand_latch', label: 'NAND latch', circuit: nandLatch as CircuitJSON },
  { key: 'register_bus_4bit', label: '4-bit register bus', circuit: registerBus as CircuitJSON },
  { key: 'ripple_adder_4bit', label: '4-bit ripple adder', circuit: rippleAdder as CircuitJSON },
  { key: 'hex_display_28c16', label: 'Hex display (28C16)', circuit: hexDisplay28C16 as CircuitJSON },
  { key: 'ben_eater_8bit',    label: 'Ben Eater 8-bit (Fibonacci)', circuit: benEater8bit as CircuitJSON },
  { key: 'original_digital_cpu_generated', label: 'Bryan\'s Digital CPU (generated port)', circuit: originalDigitalCpu as unknown as CircuitJSON },
];

// Minimal subset of the File System Access API types we actually use. The
// browser-provided types may be richer; redeclaring locally keeps the file
// self-contained and survives lib upgrades.
interface FilePickerType {
  description?: string;
  accept: Record<string, string[]>;
}
interface SaveFilePickerOptions {
  suggestedName?: string;
  types?: FilePickerType[];
}
interface OpenFilePickerOptions {
  multiple?: boolean;
  types?: FilePickerType[];
}
interface SaveFilePicker {
  (opts: SaveFilePickerOptions): Promise<FileSystemFileHandle>;
}
interface OpenFilePicker {
  (opts: OpenFilePickerOptions): Promise<FileSystemFileHandle[]>;
}

const getSaveFilePicker = (): SaveFilePicker | undefined =>
  (window as Window & { showSaveFilePicker?: SaveFilePicker }).showSaveFilePicker;
const getOpenFilePicker = (): OpenFilePicker | undefined =>
  (window as Window & { showOpenFilePicker?: OpenFilePicker }).showOpenFilePicker;

export const mountFileControls = (host: HTMLElement, editor: EditorModel): (() => void) => {
  host.innerHTML = '';

  const saveBtn = button('Save', 'save');
  const downloadBtn = button('Download JSON', 'download');
  const uploadBtn = button('Open JSON', 'upload');
  const showBtn = button('Circuit JSON', 'show-json');
  const pasteBtn = button('Paste JSON', 'paste-json');
  const newBtn = button('New circuit', 'new');
  const loadBtn = button('Load', 'load');
  const fileInput = document.createElement('input');
  fileInput.type = 'file';
  fileInput.accept = '.json,application/json';
  fileInput.dataset.fileAction = 'load-input';
  fileInput.style.display = 'none';
  fileInput.addEventListener('change', () => {
    const file = fileInput.files?.[0];
    if (!file) return;
    void editor.loadCircuit(file.text().then((text) => JSON.parse(text) as CircuitJSON))
      .catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        editor.reportError(msg);
      })
      .finally(() => {
        // Reset so loading the same file twice fires the change event again.
        fileInput.value = '';
      });
  });

  saveBtn.addEventListener('click', () => {
    void saveCircuit(editor).catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      editor.reportError(msg);
    });
  });

  const jsonDialog = document.createElement('dialog');
  jsonDialog.className = 'json-dialog';
  jsonDialog.setAttribute('aria-label', 'Circuit JSON export');
  const jsonHint = document.createElement('p');
  const jsonText = document.createElement('textarea');
  jsonText.readOnly = true;
  jsonText.setAttribute('aria-label', 'Circuit JSON');
  jsonText.spellcheck = false;
  const closeJson = button('Close JSON', 'close-json');
  closeJson.addEventListener('click', () => jsonDialog.close());
  jsonDialog.append(jsonHint, jsonText, closeJson);
  document.body.append(jsonDialog);
  const pasteDialog = document.createElement('dialog');
  pasteDialog.className = 'json-dialog';
  pasteDialog.setAttribute('aria-label', 'Open circuit JSON');
  const pasteText = document.createElement('textarea');
  pasteText.setAttribute('aria-label', 'Paste circuit JSON');
  pasteText.spellcheck = false;
  const pasteHint = document.createElement('p'); pasteHint.textContent = 'Paste a saved circuit JSON file, including its chip library.';
  const pasteError = document.createElement('p'); pasteError.setAttribute('role', 'alert');
  const openPaste = button('Open pasted JSON', 'open-pasted-json');
  openPaste.addEventListener('click', () => {
    openPaste.disabled = true;
    void Promise.resolve().then(() => editor.replaceCircuit(JSON.parse(pasteText.value) as CircuitJSON)).then(() => pasteDialog.close()).catch((error: unknown) => {
      pasteError.textContent = error instanceof Error ? error.message : String(error);
    }).finally(() => { openPaste.disabled = false; });
  });
  const cancelPaste = button('Cancel paste', 'cancel-paste'); cancelPaste.addEventListener('click', () => pasteDialog.close());
  pasteDialog.append(pasteHint, pasteText, pasteError, openPaste, cancelPaste); document.body.append(pasteDialog);
  pasteBtn.addEventListener('click', () => { pasteText.value = ''; pasteError.textContent = ''; pasteDialog.showModal(); pasteText.focus(); });

  showBtn.addEventListener('click', () => {
    void editor.whenIdle().then(() => {
      jsonHint.textContent = `Copy this circuit and its chip library into ${editor.project.name || 'circuit'}.json. This is the same content as Download JSON.`;
      jsonText.value = JSON.stringify(editor.project, null, 2);
      if (!jsonDialog.open) jsonDialog.showModal();
      jsonText.focus(); jsonText.select();
    });
  });

  downloadBtn.addEventListener('click', () => {
    void editor.whenIdle().then(() => downloadCircuit(editor.project));
  });
  uploadBtn.addEventListener('click', () => fileInput.click());
  newBtn.addEventListener('click', () => { void editor.newCircuit().catch(() => {}); });

  loadBtn.addEventListener('click', () => {
    void openCircuit(editor, fileInput).catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      editor.reportError(msg);
    });
  });

  const examplesSelect = document.createElement('select');
  examplesSelect.dataset.fileAction = 'examples';
  const placeholder = document.createElement('option');
  placeholder.value = '';
  placeholder.textContent = 'Examples…';
  examplesSelect.appendChild(placeholder);
  for (const ex of EXAMPLES) {
    const opt = document.createElement('option');
    opt.value = ex.key;
    opt.textContent = ex.label;
    examplesSelect.appendChild(opt);
  }
  examplesSelect.addEventListener('change', () => {
    const key = examplesSelect.value;
    examplesSelect.value = '';
    if (!key) return;
    const ex = EXAMPLES.find((e) => e.key === key);
    if (!ex) return;
    // Deep-clone so user edits don't mutate the bundled JSON across reloads.
    const fresh = JSON.parse(JSON.stringify(ex.circuit)) as CircuitJSON;
    void editor.replaceCircuit(fresh).catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      editor.reportError(msg);
    });
  });

  host.append(newBtn, saveBtn, downloadBtn, showBtn, loadBtn, uploadBtn, pasteBtn, examplesSelect, fileInput);
  const refresh = (): void => {
    for (const control of [newBtn, saveBtn, downloadBtn, showBtn, loadBtn, uploadBtn, pasteBtn, examplesSelect]) control.disabled = editor.state.editingChip !== null;
  };
  const unsub = editor.subscribe(refresh); refresh();

  return () => {
    unsub();
    jsonDialog.remove();
    pasteDialog.remove();
    host.innerHTML = '';
  };
};

const button = (label: string, action: string): HTMLButtonElement => {
  const b = document.createElement('button');
  b.type = 'button';
  b.textContent = label;
  b.dataset.fileAction = action;
  return b;
};

const saveCircuit = async (editor: EditorModel): Promise<void> => {
  const filename = `${editor.project.name || 'circuit'}.json`;
  const sfp = getSaveFilePicker();
  if (sfp) {
    try {
      // Open the picker during the user gesture. Waiting first could lose
      // transient activation; capture the committed document after it opens.
      const handle = await sfp({
        suggestedName: filename,
        types: [
          { description: 'Bread circuit', accept: { 'application/json': ['.json'] } },
        ],
      });
      await editor.whenIdle();
      const writable = await handle.createWritable();
      await writable.write(JSON.stringify(editor.project, null, 2));
      await writable.close();
      return;
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return;
      // Fall through to download.
    }
  }
  await editor.whenIdle();
  downloadCircuit(editor.project);
};

const downloadCircuit = (circuit: CircuitJSON): void => {
  const data = JSON.stringify(circuit, null, 2);
  const filename = `${circuit.name || 'circuit'}.json`;
  const blob = new Blob([data], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
};

const openCircuit = async (editor: EditorModel, fallbackInput: HTMLInputElement): Promise<void> => {
  const ofp = getOpenFilePicker();
  if (ofp) {
    try {
      await editor.loadCircuit(ofp({
        types: [
          { description: 'Bread circuit', accept: { 'application/json': ['.json'] } },
        ],
      }).then(async ([handle]) => {
        if (!handle) return null;
        const file = await handle.getFile();
        return JSON.parse(await file.text()) as CircuitJSON;
      }));
      return;
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return;
      // Fall through to input fallback.
    }
  }
  fallbackInput.click();
};
