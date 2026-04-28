// Save and Load buttons. Uses File System Access API
// (showSaveFilePicker / showOpenFilePicker) when available; falls back to
// `<a download>` for save and a hidden `<input type=file>` for load. The
// input is mounted into the DOM (not dynamically created) so Playwright can
// drive it via setInputFiles().

import type { CircuitJSON } from '../engine/ir';
import type { EditorModel } from './editor';

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
  const loadBtn = button('Load', 'load');
  const fileInput = document.createElement('input');
  fileInput.type = 'file';
  fileInput.accept = '.json,application/json';
  fileInput.dataset.fileAction = 'load-input';
  fileInput.style.display = 'none';
  fileInput.addEventListener('change', () => {
    const file = fileInput.files?.[0];
    if (!file) return;
    void file
      .text()
      .then((text) => {
        const circuit = JSON.parse(text) as CircuitJSON;
        return editor.replaceCircuit(circuit);
      })
      .catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        console.error('load failed:', msg);
      })
      .finally(() => {
        // Reset so loading the same file twice fires the change event again.
        fileInput.value = '';
      });
  });

  saveBtn.addEventListener('click', () => {
    void saveCircuit(editor.state.circuit).catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      console.error('save failed:', msg);
    });
  });

  loadBtn.addEventListener('click', () => {
    void openCircuit(editor, fileInput).catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      console.error('load failed:', msg);
    });
  });

  host.append(saveBtn, loadBtn, fileInput);

  return () => {
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

const saveCircuit = async (circuit: CircuitJSON): Promise<void> => {
  const data = JSON.stringify(circuit, null, 2);
  const filename = `${circuit.name || 'circuit'}.json`;
  const sfp = getSaveFilePicker();
  if (sfp) {
    try {
      const handle = await sfp({
        suggestedName: filename,
        types: [
          { description: 'Bread circuit', accept: { 'application/json': ['.json'] } },
        ],
      });
      const writable = await handle.createWritable();
      await writable.write(data);
      await writable.close();
      return;
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return;
      // Fall through to download.
    }
  }
  const blob = new Blob([data], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
};

const openCircuit = async (editor: EditorModel, fallbackInput: HTMLInputElement): Promise<void> => {
  const ofp = getOpenFilePicker();
  if (ofp) {
    try {
      const [handle] = await ofp({
        types: [
          { description: 'Bread circuit', accept: { 'application/json': ['.json'] } },
        ],
      });
      if (!handle) return;
      const file = await handle.getFile();
      const text = await file.text();
      const circuit = JSON.parse(text) as CircuitJSON;
      await editor.replaceCircuit(circuit);
      return;
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return;
      // Fall through to input fallback.
    }
  }
  fallbackInput.click();
};
