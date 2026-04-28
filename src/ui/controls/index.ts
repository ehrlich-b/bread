// Run / Pause / Step buttons. The label, behavior, and ordering match the M3
// demo because the Playwright e2e suite asserts on them.

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
  host.append(runBtn, pauseBtn, stepBtn);
  return () => {
    host.innerHTML = '';
  };
};
