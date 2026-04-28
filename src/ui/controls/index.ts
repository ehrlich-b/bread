// Run / Pause / Step / Undo / Redo buttons. Run/Pause/Step preserve their M3
// labels and order because the existing Playwright e2e asserts on them.
// Undo / Redo update their `disabled` state from editor stack depth.

import type { EditorModel } from '../editor';

const button = (label: string, onClick: () => void): HTMLButtonElement => {
  const b = document.createElement('button');
  b.type = 'button';
  b.textContent = label;
  b.addEventListener('click', onClick);
  return b;
};

export const mountControls = (host: HTMLElement, editor: EditorModel): (() => void) => {
  host.innerHTML = '';
  const runBtn = button('Run', () => {
    void editor.bus.run(1000);
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

  host.append(runBtn, pauseBtn, stepBtn, undoBtn, redoBtn);

  const unsub = editor.subscribe(refresh);
  return () => {
    host.innerHTML = '';
    unsub();
  };
};
