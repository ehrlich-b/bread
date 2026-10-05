import type { EditorModel } from './editor';
import { busPairs, numberedPins } from './signals';

export const showBusDialog = (editor: EditorModel, from: string, to: string): (() => void) => {
  const a = numberedPins(editor.state.circuit, from); const b = numberedPins(editor.state.circuit, to);
  const dialog = document.createElement('dialog'); dialog.className = 'chip-dialog'; dialog.setAttribute('aria-label', 'Connect bus');
  const title = document.createElement('h2'); title.textContent = 'Connect bus';
  const hint = document.createElement('p'); hint.textContent = `${a.label} (${a.dir}) → ${b.label} (${b.dir}). Bits connect in ascending numbered order. Each line remains a separate signal.`;
  const label = document.createElement('label'); label.textContent = 'Bus width ';
  const width = document.createElement('input'); width.type = 'number'; width.min = '1'; width.max = String(Math.min(a.endpoints.length, b.endpoints.length));
  width.step = '1'; width.value = width.max; width.setAttribute('aria-label', 'Bus width'); label.append(width);
  const mapping = document.createElement('ol');
  const error = document.createElement('p'); error.setAttribute('role', 'alert');
  const connect = document.createElement('button'); connect.type = 'button'; connect.textContent = 'Connect these bits';
  const cancel = document.createElement('button'); cancel.type = 'button'; cancel.textContent = 'Cancel bus';
  const refresh = (): void => {
    mapping.replaceChildren(); error.textContent = '';
    try {
      for (const [source, target] of busPairs(editor.state.circuit, from, to, Number(width.value))) {
        const item = document.createElement('li'); item.textContent = `${source} → ${target}`; mapping.append(item);
      }
      connect.disabled = false;
    } catch (reason) { connect.disabled = true; error.textContent = reason instanceof Error ? reason.message : String(reason); }
  };
  width.addEventListener('input', refresh);
  connect.addEventListener('click', () => {
    connect.disabled = true;
    void editor.connectBus(from, to, Number(width.value)).then(() => dialog.remove()).catch((reason: unknown) => {
      error.textContent = reason instanceof Error ? reason.message : String(reason); connect.disabled = false;
    });
  });
  cancel.addEventListener('click', () => dialog.remove());
  dialog.addEventListener('cancel', () => dialog.remove());
  dialog.append(title, hint, label, mapping, error, connect, cancel); refresh(); document.body.append(dialog); dialog.showModal();
  return () => dialog.remove();
};
