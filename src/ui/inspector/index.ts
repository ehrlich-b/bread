// Property inspector. Slice 1 ships the empty shell — a panel that says
// "Nothing selected" so the layout is in place. Slice 4 fills it in with
// id / type / params / position / rotation editors that issue mutations.

import type { EditorModel } from '../editor';

export const mountInspector = (host: HTMLElement, editor: EditorModel): (() => void) => {
  const render = (): void => {
    const { selection, circuit } = editor.state;
    if (selection.size === 0) {
      host.innerHTML = '<div class="inspector-empty">Nothing selected</div>';
      return;
    }
    const ids = [...selection];
    const items = ids.map((id) => {
      const c = circuit.components.find((c) => c.id === id);
      return c ? `${c.id} (${c.type})` : id;
    });
    host.innerHTML = `<div class="inspector-empty">Selected: ${items.join(', ')}</div>`;
  };
  render();
  return editor.subscribe(render);
};
